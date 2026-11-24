import { appendFile } from "node:fs/promises";
import type { Host } from "../harness.ts";

const skipReason =
  "Clean YouTube required sign-in to confirm the viewer is not a bot";
const botChallenge = /^sign in to confirm you['’]re not a bot[.!]?$/i;
const trafficBlock = "GOOGLE_UNUSUAL_TRAFFIC";
const trafficReason = "Google reported unusual traffic from the runner";

export async function recordGuestNavigationBlock(
  host: Host,
  url: URL,
  { stockPlayback = false, env = process.env } = {},
): Promise<string | false> {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !env.GITHUB_STEP_SUMMARY ||
    url.origin !== "https://www.google.com" ||
    (url.pathname !== "/sorry/index" && url.pathname !== "/sorry/")
  )
    return false;
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `- **${host}** live test skipped. ${trafficReason}.\n`,
  );
  if (stockPlayback && env.GITHUB_ENV)
    await appendFile(env.GITHUB_ENV, `${blockVariable(host)}=${trafficBlock}\n`);
  return trafficReason;
}

function blockVariable(host: Host): string {
  return `YOUTUBE_GUEST_PLAYBACK_${host.toUpperCase().replaceAll(".", "_")}_BLOCKED`;
}

export function guestPlaybackSkip(
  host: Host,
  env = process.env,
): string | false {
  if (env.GITHUB_ACTIONS !== "true") return false;
  const value = env[blockVariable(host)];
  if (value === trafficBlock) return trafficReason;
  return value === "1" ? skipReason : false;
}

export async function recordGuestPlaybackBlock(
  host: Host,
  statuses: readonly unknown[],
  env = process.env,
): Promise<string | false> {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !env.GITHUB_ENV ||
    !env.GITHUB_STEP_SUMMARY
  )
    return false;
  const status = statuses[0] ?? statuses[1];
  const blocked =
    !!status &&
    typeof status === "object" &&
    "status" in status &&
    status.status === "LOGIN_REQUIRED" &&
    "reason" in status &&
    typeof status.reason === "string" &&
    botChallenge.test(status.reason.trim());
  if (!blocked) return false;
  await appendFile(
    env.GITHUB_STEP_SUMMARY,
    `- **${host}** guest playback skipped. ${skipReason}.\n`,
  );
  await appendFile(env.GITHUB_ENV, `${blockVariable(host)}=1\n`);
  return skipReason;
}
