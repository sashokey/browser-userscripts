export type TimedLyric = { text: string; start: number };
export const lyricsTimeout = 8000;

function readField(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value === null || typeof value !== "object") return;
    value = Reflect.get(value, key);
  }
  return value;
}

function milliseconds(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
}

function parseTimedLyrics(data: unknown): TimedLyric[] | undefined {
  const lines = readField(
    data,
    "contents",
    "elementRenderer",
    "newElement",
    "type",
    "componentType",
    "model",
    "timedLyricsModel",
    "lyricsData",
    "timedLyricsData",
  );
  if (!Array.isArray(lines)) return;
  const entries: unknown[] = lines;
  const timed: TimedLyric[] = [];
  for (const entry of entries) {
    const text = readField(entry, "lyricLine");
    if (typeof text !== "string") return;
    if (!text.trim()) continue;
    const cue = readField(entry, "cueRange");
    const start = milliseconds(readField(cue, "startTimeMilliseconds"));
    const end = milliseconds(readField(cue, "endTimeMilliseconds"));
    const previous = timed.at(-1);
    if (
      start === undefined ||
      end === undefined ||
      (previous && start < previous.start) ||
      end < start
    )
      return;
    if (previous?.start === start) previous.text += `\n${text.trim()}`;
    else timed.push({ text: text.trim(), start });
  }
  if (timed.length) return timed;
}

async function request(
  endpoint: "next" | "browse",
  client: { clientName: string; clientVersion: string; platform: string },
  body: { videoId: string } | { browseId: string },
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const result = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: { client }, ...body }),
    signal,
  });
  if (!result.ok) return;
  const data: unknown = await result.json();
  signal.throwIfAborted();
  return data;
}

export async function fetchTimedLyrics(
  videoId: string,
  webVersion: string,
  lifetime: AbortSignal,
  onAvailability?: (available: boolean) => void,
  timeout = lyricsTimeout,
): Promise<TimedLyric[] | undefined> {
  if (!/^[\w-]{11}$/.test(videoId) || !/^\d+(?:\.\d+)+$/.test(webVersion))
    return;
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeout)]);
  try {
    const watch = await request(
      "next",
      {
        clientName: "WEB_REMIX",
        clientVersion: webVersion,
        platform: "DESKTOP",
      },
      { videoId },
      signal,
    );
    const tabs = readField(
      watch,
      "contents",
      "singleColumnMusicWatchNextResultsRenderer",
      "tabbedRenderer",
      "watchNextTabbedResultsRenderer",
      "tabs",
    );
    if (!Array.isArray(tabs)) return;
    const candidates: unknown[] = tabs;
    for (const tab of candidates) {
      const renderer = readField(tab, "tabRenderer");
      const browseId = readField(
        renderer,
        "endpoint",
        "browseEndpoint",
        "browseId",
      );
      if (typeof browseId !== "string" || !/^MPLY[\w-]+$/.test(browseId))
        continue;
      const available = readField(renderer, "unselectable") !== true;
      onAvailability?.(available);
      if (!available) return;
      const lyrics = await request(
        "browse",
        {
          clientName: "ANDROID_MUSIC",
          clientVersion: "7.21.50",
          platform: "MOBILE",
        },
        { browseId },
        signal,
      );
      return parseTimedLyrics(lyrics);
    }
  } catch {
    return;
  }
}

export function activeLyricIndex(
  lines: readonly TimedLyric[],
  time: number,
): number {
  let start = 0;
  let end = lines.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    const line = lines[middle];
    if (line && line.start <= time) start = middle + 1;
    else end = middle;
  }
  return Math.max(0, start - 1);
}
