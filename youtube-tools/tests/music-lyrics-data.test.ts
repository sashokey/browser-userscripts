import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeLyricIndex,
  fetchTimedLyrics,
} from "../src/music-lyrics-data.ts";

const lyricsTab = {
  tabRenderer: {
    endpoint: { browseEndpoint: { browseId: "MPLYt_example" } },
  },
};
const watch = {
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: { watchNextTabbedResultsRenderer: { tabs: [lyricsTab] } },
    },
  },
};

function timed(entries: unknown[]): object {
  return {
    contents: {
      elementRenderer: {
        newElement: {
          type: {
            componentType: {
              model: {
                timedLyricsModel: { lyricsData: { timedLyricsData: entries } },
              },
            },
          },
        },
      },
    },
  };
}

const first = {
  lyricLine: "First",
  cueRange: { startTimeMilliseconds: "2100", endTimeMilliseconds: "3600" },
};
const last = {
  lyricLine: "Last",
  cueRange: { startTimeMilliseconds: "5200", endTimeMilliseconds: "7600" },
};
const lines = [
  { text: "First", start: 2100 },
  { text: "Last", start: 5200 },
];

void test("fetches line timings from YouTube Music without sending credentials", async (context) => {
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) => {
      assert.equal(init.credentials, "omit");
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).has("Authorization"), false);
      assert.ok(typeof init.body === "string");
      const body: unknown = JSON.parse(init.body);
      if (url === "/youtubei/v1/next?prettyPrint=false") {
        assert.deepEqual(body, {
          context: {
            client: {
              clientName: "WEB_REMIX",
              clientVersion: "1.20261122.17.00",
              platform: "DESKTOP",
            },
          },
          videoId: "yntRHKkkWic",
        });
        return Promise.resolve(Response.json(watch));
      }
      assert.equal(url, "/youtubei/v1/browse?prettyPrint=false");
      assert.deepEqual(body, {
        context: {
          client: {
            clientName: "ANDROID_MUSIC",
            clientVersion: "7.21.50",
            platform: "MOBILE",
          },
        },
        browseId: "MPLYt_example",
      });
      return Promise.resolve(Response.json(timed([first, last])));
    },
  );

  assert.deepEqual(
    await fetchTimedLyrics(
      "yntRHKkkWic",
      "1.20261122.17.00",
      new AbortController().signal,
    ),
    lines,
  );
  assert.equal(fetch.mock.callCount(), 2);
});

void test("falls back on missing or invalid line timings", async (context) => {
  const responses = [
    { contents: { sectionListRenderer: {} } },
    timed([first, { lyricLine: "Untimed" }]),
    timed([last, first]),
    timed([
      {
        ...first,
        cueRange: { startTimeMilliseconds: "8000", endTimeMilliseconds: "100" },
      },
    ]),
  ];
  const fetch = context.mock.method(globalThis, "fetch", (url: string) =>
    Promise.resolve(
      Response.json(url.includes("/next?") ? watch : responses.shift()),
    ),
  );

  for (let index = 0; index < 4; index += 1)
    assert.equal(
      await fetchTimedLyrics(
        "yntRHKkkWic",
        "1.20261122.17.00",
        new AbortController().signal,
      ),
      undefined,
    );
  assert.equal(fetch.mock.callCount(), 8);
});

void test("keeps every lyric line when several share a start time", async (context) => {
  context.mock.method(globalThis, "fetch", (url: string) =>
    Promise.resolve(
      Response.json(
        url.includes("/next?")
          ? watch
          : timed([first, { ...first, lyricLine: "Together" }, last]),
      ),
    ),
  );

  assert.deepEqual(
    await fetchTimedLyrics(
      "yntRHKkkWic",
      "1.20261122.17.00",
      new AbortController().signal,
    ),
    [
      { text: "First\nTogether", start: 2100 },
      { text: "Last", start: 5200 },
    ],
  );
});

void test("leaves native lyrics available after HTTP, JSON or transport errors", async (context) => {
  const failures = [
    new Response(null, { status: 503 }),
    new Response("not JSON"),
    null,
  ];
  context.mock.method(globalThis, "fetch", () => {
    const response = failures.shift();
    return response
      ? Promise.resolve(response)
      : Promise.reject(new TypeError("offline"));
  });

  for (let index = 0; index < 3; index += 1)
    assert.equal(
      await fetchTimedLyrics(
        "yntRHKkkWic",
        "1.20261122.17.00",
        new AbortController().signal,
      ),
      undefined,
    );
});

void test("stops the lyric lookup when the track changes during the request", async (context) => {
  const controller = new AbortController();
  const fetch = context.mock.method(globalThis, "fetch", () => {
    controller.abort();
    return Promise.resolve(Response.json(watch));
  });

  assert.equal(
    await fetchTimedLyrics(
      "yntRHKkkWic",
      "1.20261122.17.00",
      controller.signal,
    ),
    undefined,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

void test("anchors the first and last lines and recomputes the line after a seek", () => {
  assert.equal(activeLyricIndex(lines, 0), 0);
  assert.equal(activeLyricIndex(lines, 5199), 0);
  assert.equal(activeLyricIndex(lines, 5200), 1);
  assert.equal(activeLyricIndex(lines, 20_000), 1);
  assert.equal(activeLyricIndex(lines, 2500), 0);
});
