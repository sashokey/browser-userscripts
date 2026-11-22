import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { musicRows } from "./live/music-page.ts";

const file =
  process.env.YOUTUBE_TOOLS_ARTIFACT === "youtube-tools.debug.js"
    ? "youtube-tools.debug.js"
    : "youtube-tools.user.js";
const code = await readFile(new URL(`../${file}`, import.meta.url), "utf8");

const song = "MUSIC_VIDEO_TYPE_ATV";
const clip = "MUSIC_VIDEO_TYPE_OMV";
const clipId = "dQw4w9WgXcQ";
const songId = "9bZkp7q19f0";

function item(videoId: string, kind?: string, saved = false) {
  const watchEndpoint = {
    videoId,
    ...(kind
      ? {
          watchEndpointMusicSupportedConfigs: {
            watchEndpointMusicConfig: { musicVideoType: kind },
          },
        }
      : {}),
  };
  return {
    playlistPanelVideoRenderer: {
      videoId,
      navigationEndpoint: { watchEndpoint },
      ...(saved
        ? {
            menu: {
              menuRenderer: {
                items: [
                  {
                    toggleMenuServiceItemRenderer: {
                      defaultIcon: { iconType: "BOOKMARK_BORDER" },
                      toggledIcon: { iconType: "BOOKMARK" },
                    },
                  },
                ],
              },
            },
          }
        : {}),
    },
  };
}

function application(items: ReturnType<typeof item>[], response?: object) {
  const calls: string[] = [];
  const selections: number[] = [];
  let index = 0;
  let pauses = 0;
  let loaded: string | undefined;
  const playerApi = {
    playVideo: () => calls.push("play"),
    loadVideoByPlayerVars: ({ video_id }: { video_id: string }) =>
      calls.push(video_id),
    getPlayerResponse: () => response,
    getVideoData: () => ({ video_id: loaded }),
    pauseVideo: () => {
      pauses++;
    },
  };
  return {
    calls,
    selections,
    pauses: () => pauses,
    select: (next: number) => {
      index = next;
    },
    setLoaded: (id: string) => {
      loaded = id;
    },
    playerApi,
    root: {
      isConnected: true,
      querySelectorAll: () => [],
      queue: {
        playerApi,
        getItems: () => items,
        getCurrentItemIndex: () => index,
        selectQueueItem: (entry: ReturnType<typeof item>) => {
          selections.push(items.indexOf(entry));
        },
      },
    },
  };
}

function openMusic(
  first: ReturnType<typeof application>,
  path = `/watch?v=${clipId}`,
  repeatMode = "NONE",
) {
  let active = first.root;
  let blocked = false;
  const observations = new Map<object, (records: unknown[]) => void>();
  class Observer {
    readonly callback: (records: unknown[]) => void;
    constructor(callback: (records: unknown[]) => void) {
      this.callback = callback;
    }
    observe(target: object) {
      observations.set(target, this.callback);
    }
    disconnect() {
      for (const [target, callback] of observations)
        if (callback === this.callback) observations.delete(target);
    }
  }
  const window = {
    get top() {
      return window;
    },
  };
  const document = {
    querySelector: (selector: string) =>
      selector === "ytmusic-player-bar" ? { repeatMode } : active,
    documentElement: {
      toggleAttribute(name: string, value: boolean) {
        if (name === "data-youtube-tools-blocked") blocked = value;
      },
    },
    addEventListener() {},
  };
  const location = new URL(path, "https://music.youtube.com");
  runInNewContext(code, {
    window,
    location,
    document,
    GM_addStyle() {},
    MutationObserver: Observer,
    queueMicrotask,
    URLSearchParams,
  });
  return {
    blocked: () => blocked,
    navigate: (next: string) => {
      location.href = new URL(next, location).href;
    },
    update: () => observations.get(active)?.([]),
    detach: () => {
      active.isConnected = false;
    },
    replace(next: ReturnType<typeof application>) {
      active.isConnected = false;
      active = next.root;
      observations.get(document)?.([]);
    },
  };
}

void test("a native play method is guarded in the same turn it is reassigned", () => {
  const app = application([item(clipId, clip)]);
  openMusic(app);
  app.playerApi.playVideo();
  assert.deepEqual(app.calls, []);
  app.playerApi.playVideo = () => app.calls.push("replacement");
  app.playerApi.playVideo();
  assert.deepEqual(app.calls, []);
});

void test("verified audio metadata permits a track with an unspecified queue type", () => {
  const app = application([item(songId)], {
    videoDetails: { videoId: songId, musicVideoType: song },
  });
  openMusic(app, `/watch?v=${songId}`);
  app.playerApi.playVideo();
  assert.deepEqual(app.calls, ["play"]);
});

for (const source of ["queue", "player"] as const) {
  void test(`Music keeps personal audio uploads playable through ${source} metadata`, () => {
    const uploaded = "MUSIC_VIDEO_TYPE_PRIVATELY_OWNED_TRACK";
    const app =
      source === "queue"
        ? application([item(songId, uploaded)])
        : application([item(songId)], {
            videoDetails: { videoId: songId, musicVideoType: uploaded },
          });
    const page = openMusic(app, `/watch?v=${songId}`);
    app.playerApi.playVideo();
    assert.deepEqual(app.calls, ["play"]);
    assert.equal(page.blocked(), false);
  });
}

void test("Repeat All advances from a last video to the first available song", async () => {
  const app = application([
    item(songId, song),
    item("current", song),
    item(clipId, clip),
  ]);
  openMusic(app, "/watch?v=current", "ALL");
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: "current" });
  app.select(2);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  assert.deepEqual(app.selections, [0]);
});

for (const direction of ["Next", "Previous"] as const) {
  void test(`Repeat All keeps the direction of ${direction} when the native queue wraps to a video`, async () => {
    const a = item(songId, song);
    const b = item("second", song);
    const video = item(clipId, clip);
    const goingForward = direction === "Next";
    const app = application(goingForward ? [video, a, b] : [a, b, video]);
    const previousId = goingForward ? "second" : songId;
    openMusic(app, `/watch?v=${previousId}`, "ALL");
    app.select(goingForward ? 2 : 0);
    app.playerApi.loadVideoByPlayerVars({ video_id: previousId });
    app.select(goingForward ? 0 : 2);
    app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
    await Promise.resolve();
    assert.deepEqual(app.selections, [1]);
  });
}

void test("opening a direct clip leaves an available song stopped", async () => {
  const app = application([item(clipId, clip), item(songId, song)]);
  const page = openMusic(app);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.selections, []);
  assert.equal(page.blocked(), true);
});

void test("an explicit clip opened within the same Music app does not advance its old queue", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("later", song),
  ]);
  const page = openMusic(app, `/watch?v=${songId}&list=test`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  page.navigate(`/watch?v=${clipId}`);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  assert.deepEqual(app.calls, [songId]);
  assert.deepEqual(app.selections, []);
  assert.equal(page.blocked(), true);
  assert.equal(app.pauses(), 1);
});

void test("a bookmarked queue item cannot override verified clip metadata", () => {
  const app = application([item(clipId, undefined, true)], {
    videoDetails: { videoId: clipId, musicVideoType: clip },
  });
  openMusic(app);
  app.playerApi.playVideo();
  assert.deepEqual(app.calls, []);
});

void test("a rejected final video leaves the current song interface visible", async () => {
  const app = application([item(songId, song), item(clipId, clip)]);
  const page = openMusic(app, `/watch?v=${songId}`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  assert.deepEqual(app.calls, [songId]);
  assert.equal(page.blocked(), false);
});

void test("replacing the Music root guards the new player and releases the old one", () => {
  const first = application([item(clipId, clip)]);
  const page = openMusic(first);
  const replacement = application([item(clipId, clip)]);
  page.replace(replacement);
  replacement.playerApi.playVideo();
  first.playerApi.playVideo();
  assert.deepEqual(replacement.calls, []);
  assert.deepEqual(first.calls, ["play"]);
});

void test("a protected native method does not break filtering or other player guards", () => {
  const app = application([item(clipId, clip)]);
  Object.defineProperty(app.playerApi, "loadVideoByPlayerVars", {
    get() {
      throw new Error("protected player method");
    },
  });
  const page = openMusic(app);
  assert.equal(page.blocked(), true);
  app.playerApi.playVideo();
  assert.deepEqual(app.calls, []);
});

void test("a replaced player on the same queue releases the old native method", () => {
  const first = application([item(clipId, clip)]);
  openMusic(first);
  const next = application([item(clipId, clip)]);
  first.root.queue.playerApi = next.playerApi;
  next.playerApi.playVideo();
  first.root.queue.getItems = () => {
    throw new Error("stale queue read");
  };
  first.playerApi.playVideo();
  assert.deepEqual(next.calls, []);
  assert.deepEqual(first.calls, ["play"]);
});

void test("a pending skip cannot select another song after its app detaches", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("later", song),
  ]);
  const page = openMusic(app, `/watch?v=${songId}`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.detach();
  await Promise.resolve();
  assert.deepEqual(app.selections, []);
});

void test("a denied last clip cannot prevent resuming the song still loaded", async () => {
  const app = application([item(songId, song), item(clipId, clip)]);
  openMusic(app, `/watch?v=${songId}`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.setLoaded(songId);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  app.playerApi.playVideo();
  assert.deepEqual(app.calls, [songId, "play"]);
});

void test("Previous follows the selected occurrence when a song is repeated", async () => {
  const app = application([
    item(songId, song),
    item("earlier", song),
    item(clipId, clip),
    item(songId, song),
    item("later", song),
  ]);
  openMusic(app, `/watch?v=${songId}`);
  app.select(3);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(2);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  assert.deepEqual(app.selections, [1]);
});

void test("unrelated page mutations do not retry a rejected last video", async () => {
  const items = [item(songId, song), item(clipId, clip)];
  const app = application(items);
  let reads = 0;
  app.root.queue.getItems = () => {
    reads++;
    return items;
  };
  const page = openMusic(app, `/watch?v=${songId}`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await Promise.resolve();
  const before = reads;
  for (let index = 0; index < 10; index++) page.update();
  assert.equal(reads, before);
});

void test("the Music smoke test counts a clip linked through its text column", () => {
  const row = {
    getClientRects: () => [0],
    data: {
      navigationEndpoint: { browseEndpoint: {} },
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  navigationEndpoint: item(clipId, clip)
                    .playlistPanelVideoRenderer.navigationEndpoint,
                },
              ],
            },
          },
        },
      ],
    },
  };
  const result: unknown = runInNewContext(`(${musicRows.toString()})("rows")`, {
    document: { querySelectorAll: () => [row] },
    getComputedStyle: () => ({ visibility: "visible" }),
  });
  assert.equal(
    JSON.stringify(result),
    JSON.stringify({ visibleTracks: 0, visibleClips: 1, classified: 1 }),
  );
});
