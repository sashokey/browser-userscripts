import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  guestPlaybackSkip,
  recordGuestNavigationBlock,
  recordGuestPlaybackBlock,
} from "./live/guest-playback.ts";

const challenge = "Sign in to confirm you’re not a bot";
const loginChallenge = { status: "LOGIN_REQUIRED", reason: challenge };

void test("only a Google unusual-traffic redirect records a skip for the affected CI test", async () => {
  const directory = await mkdtemp(join(tmpdir(), "youtube-tools-guest-"));
  try {
    const summary = join(directory, "summary");
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: join(directory, "env"),
      GITHUB_STEP_SUMMARY: summary,
    };
    const blocked = new URL("https://www.google.com/sorry/index");
    assert.equal(
      await recordGuestNavigationBlock("m.youtube.com", blocked, { env: {} }),
      false,
    );
    for (const url of [
      "https://www.google.com/",
      "https://www.google.com/sorry/unrelated",
      "https://www.google.com.example/sorry/index",
      "https://consent.youtube.com/",
    ]) {
      assert.equal(
        await recordGuestNavigationBlock("m.youtube.com", new URL(url), {
          env,
        }),
        false,
      );
    }
    await assert.rejects(readFile(summary), { code: "ENOENT" });
    assert.match(
      (await recordGuestNavigationBlock("m.youtube.com", blocked, { env })) || "",
      /unusual traffic/i,
    );
    assert.match(
      await readFile(summary, "utf8"),
      /m\.youtube\.com.*skipped.*unusual traffic/i,
    );
    assert.equal(guestPlaybackSkip("m.youtube.com", env), false);
    await assert.rejects(readFile(env.GITHUB_ENV), { code: "ENOENT" });
    const reason = await recordGuestNavigationBlock("m.youtube.com", blocked, {
      env,
      stockPlayback: true,
    });
    const value = await readFile(env.GITHUB_ENV, "utf8");
    const subsequentStep = {
      GITHUB_ACTIONS: "true",
      ...Object.fromEntries(new URLSearchParams(value.trim())),
    };
    assert.equal(guestPlaybackSkip("m.youtube.com", subsequentStep), reason);
    assert.equal(guestPlaybackSkip("www.youtube.com", subsequentStep), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("a clean YouTube bot challenge records a CI skip for exactly the affected host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "youtube-tools-guest-"));
  try {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_ENV: join(directory, "env"),
      GITHUB_STEP_SUMMARY: join(directory, "summary"),
    };
    const reason = await recordGuestPlaybackBlock(
      "m.youtube.com",
      [null, loginChallenge],
      env,
    );
    assert.ok(reason);
    const value = await readFile(env.GITHUB_ENV, "utf8");
    const subsequentStep = {
      GITHUB_ACTIONS: "true",
      ...Object.fromEntries(new URLSearchParams(value.trim())),
    };
    assert.equal(guestPlaybackSkip("m.youtube.com", subsequentStep), reason);
    assert.equal(guestPlaybackSkip("www.youtube.com", subsequentStep), false);
    assert.equal(
      guestPlaybackSkip("m.youtube.com", {
        ...subsequentStep,
        GITHUB_ACTIONS: "false",
      }),
      false,
    );
    assert.match(
      await readFile(env.GITHUB_STEP_SUMMARY, "utf8"),
      /m\.youtube\.com.*playback skipped/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("timeouts, private videos and general sign-in requests remain failures", async () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_ENV: "/dev/null",
    GITHUB_STEP_SUMMARY: "/dev/null",
  };
  const reasons = [
    "YouTube playback did not start (readyState=0)",
    { status: "LOGIN_REQUIRED", reason: "Sign in to watch this private video" },
    { status: "UNPLAYABLE", reason: challenge },
    challenge,
  ];
  assert.equal(
    await recordGuestPlaybackBlock("www.youtube.com", reasons, env),
    false,
  );
});

void test("a manual local run reports the bot challenge as a failure", async () => {
  assert.equal(
    await recordGuestPlaybackBlock("www.youtube.com", [loginChallenge], {}),
    false,
  );
});

for (const current of [
  { status: "OK" },
  { status: "UNPLAYABLE", reason: "This video is unavailable" },
  { status: "LOGIN_REQUIRED", reason: "Sign in to watch this private video" },
] as const) {
  void test(`current player status ${current.status} takes precedence over an initial bot challenge`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "youtube-tools-guest-"));
    try {
      const env = {
        GITHUB_ACTIONS: "true",
        GITHUB_ENV: join(directory, "env"),
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
      };
      assert.equal(
        await recordGuestPlaybackBlock(
          "www.youtube.com",
          [current, loginChallenge],
          env,
        ),
        false,
      );
      await assert.rejects(readFile(env.GITHUB_ENV), { code: "ENOENT" });
      await assert.rejects(readFile(env.GITHUB_STEP_SUMMARY), {
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
