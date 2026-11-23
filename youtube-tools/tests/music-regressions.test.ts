import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
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

function item(
  videoId: string,
  kind?: string,
  saved = false,
  playlistId?: string,
) {
  const watchEndpoint = {
    videoId,
    ...(playlistId ? { playlistId } : {}),
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
  const rendered: {
    data: object;
    toggleAttribute: (name: string, force: boolean) => void;
  }[] = [];
  let index = 0;
  let pauses = 0;
  let loaded: string | undefined;
  const playerApi = {
    playVideo: () => calls.push("play"),
    loadVideoByPlayerVars: ({ video_id }: { video_id: string }) =>
      calls.push(video_id),
    cueVideoByPlayerVars: ({ video_id }: { video_id: string }) =>
      calls.push(`cue:${video_id}`),
    enqueueVideoByPlayerVars: ({ video_id }: { video_id: string }) =>
      calls.push(`enqueue:${video_id}`),
    getPlayerResponse: () => response,
    getVideoData: () => ({ video_id: loaded }),
    pauseVideo: () => {
      pauses++;
    },
  };
  return {
    calls,
    selections,
    rendered,
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
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector.startsWith("ytmusic-two-row-item-renderer,") ? rendered : [],
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
  timers = { setTimeout, clearTimeout },
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
  class Video extends EventTarget {
    paused = false;
    readonly player: object;
    constructor(videoId: string, kind: string) {
      super();
      this.player = {
        classList: { contains: () => false },
        getVideoData: () => ({ video_id: videoId }),
        getPlayerResponse: () => ({
          videoDetails: { videoId, musicVideoType: kind },
        }),
      };
    }
    closest(selector: string): object | null {
      return selector === "#movie_player" ? this.player : null;
    }
    pause(): void {
      this.paused = true;
    }
  }
  const document = Object.assign(new EventTarget(), {
    querySelector: (selector: string) =>
      selector === "ytmusic-player-bar" ? { repeatMode } : active,
    documentElement: {
      toggleAttribute(name: string, value: boolean) {
        if (name === "data-youtube-tools-blocked") blocked = value;
      },
    },
  });
  const location = new URL(path, "https://music.youtube.com");
  runInNewContext(code, {
    window,
    location,
    document,
    GM_addStyle() {},
    MutationObserver: Observer,
    HTMLVideoElement: Video,
    queueMicrotask,
    URLSearchParams,
    ...timers,
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
    playFromDom: (videoId: string, kind: string) => {
      const video = new Video(videoId, kind);
      const event = new Event("play");
      Object.defineProperty(event, "target", { value: video });
      document.dispatchEvent(event);
      return video;
    },
    replace(next: ReturnType<typeof application>) {
      active.isConnected = false;
      active = next.root;
      observations.get(document)?.([]);
    },
  };
}

void test("the DOM play fallback skips a clip using the actual queue player API", async () => {
  const app = application([
    item(songId, song),
    item(clipId, song),
    item("next-song", song),
  ]);
  const page = openMusic(app, `/watch?v=${songId}&list=PL-one`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  const video = page.playFromDom(clipId, clip);
  assert.equal(video.paused, true);
  await nextTurn();
  assert.deepEqual(app.selections, [2]);
});

void test("a first-item skip is cancelled when navigation switches to another playlist", async () => {
  const app = application([item(clipId, clip), item("old-list-song", song)]);
  const page = openMusic(app, `/watch?v=${clipId}&list=PL-old`);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.navigate("/watch?v=new-list-song&list=PL-new");
  await nextTurn();
  assert.deepEqual(app.selections, []);
});

void test("the first blocked item can use the playlist ID committed during navigation", async () => {
  const app = application([
    item(clipId, clip, false, "PL-opened"),
    item("next-song", song),
  ]);
  const page = openMusic(app, "/");
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.navigate(`/watch?v=${clipId}&list=PL-opened`);
  await nextTurn();
  assert.deepEqual(app.selections, [1]);
});

void test("a first blocked row binds to the new playlist before the old URL is replaced", async () => {
  const app = application([
    item(clipId, clip, false, "PL-opened"),
    item("next-song", song),
  ]);
  const page = openMusic(app, "/watch?v=old-song&list=PL-old");
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.navigate(`/watch?v=${clipId}&list=PL-opened`);
  await nextTurn();
  assert.deepEqual(app.selections, [1]);
});

for (const timing of ["before", "after"] as const) {
  void test(`a matching song in the old list does not reverse a new playlist opened ${timing} its URL commits`, async () => {
    const rows = [
      item("old-first", song, false, "PL-old"),
      item(songId, song, false, "PL-old"),
    ];
    const app = application(rows);
    const page = openMusic(app, `/watch?v=${songId}&list=PL-old`);
    app.select(1);
    app.playerApi.loadVideoByPlayerVars({ video_id: songId });
    rows.splice(
      0,
      rows.length,
      item(clipId, clip, false, "PL-new"),
      item(songId, song, false, "PL-new"),
      item("next-song", song, false, "PL-new"),
    );
    const url = `/watch?v=${clipId}&list=PL-new`;
    app.select(0);
    if (timing === "after") page.navigate(url);
    app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
    if (timing === "before") page.navigate(url);
    await nextTurn();
    assert.deepEqual(app.selections, [1]);
  });
}

void test("a new named playlist rejects the origin of a different list-less queue", async () => {
  const rows = [item("old-first", song), item(songId, song)];
  const app = application(rows);
  const page = openMusic(app, `/watch?v=${songId}`);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  rows.splice(
    0,
    rows.length,
    item(clipId, clip, false, "PL-new"),
    item(songId, song, false, "PL-new"),
    item("next-song", song, false, "PL-new"),
  );
  app.select(0);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.navigate(`/watch?v=${clipId}&list=PL-new`);
  await nextTurn();
  assert.deepEqual(app.selections, [1]);
});

void test("Repeat All can wrap to the song verified only by native playback metadata", async () => {
  const app = application([item(songId), item(clipId, clip)], {
    videoDetails: { videoId: songId, musicVideoType: song },
  });
  openMusic(app, `/watch?v=${songId}&list=PL-one`, "ALL");
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await nextTurn();
  assert.deepEqual(app.selections, [0]);
});

void test("Repeat All reloads a verified song after the DOM catches a clip", async () => {
  const rows = [item(songId), item(clipId, clip)];
  const app = application(rows);
  let playing = { videoId: songId, musicVideoType: song };
  app.playerApi.getPlayerResponse = () => ({ videoDetails: playing });
  const page = openMusic(app, `/watch?v=${songId}&list=PL-one`, "ALL");
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  app.setLoaded(clipId);
  playing = { videoId: clipId, musicVideoType: clip };
  app.root.queue.selectQueueItem = (entry) => {
    const index = rows.indexOf(entry);
    app.selections.push(index);
    if (app.selections.length > 1) return;
    app.select(index);
    app.playerApi.loadVideoByPlayerVars({
      video_id: entry.playlistPanelVideoRenderer.videoId,
    });
  };
  assert.equal(page.playFromDom(clipId, clip).paused, true);
  await nextTurn();
  assert.deepEqual(app.selections, [0]);
  assert.deepEqual(app.calls, [songId, songId]);
  assert.equal(page.blocked(), false);
});

void test("Repeat All never cycles through occurrences of the same verified clip", async () => {
  const rows = [item(clipId, undefined, true), item(clipId, undefined, true)];
  const app = application(rows, {
    videoDetails: { videoId: clipId, musicVideoType: clip },
  });
  openMusic(app, `/watch?v=${clipId}&list=PL-clips`, "ALL");
  app.setLoaded(clipId);
  app.root.queue.selectQueueItem = (entry) => {
    const index = rows.indexOf(entry);
    app.selections.push(index);
    if (app.selections.length >= 6) return;
    app.select(index);
    app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  };
  app.playerApi.playVideo();
  await nextTurn();
  assert.deepEqual(app.selections, []);
  assert.deepEqual(app.calls, []);
});

void test("Repeat All stops after the DOM identifies different bookmarked clips", async () => {
  const otherClip = "other-clip";
  const rows = [
    item(clipId, undefined, true),
    item(otherClip, undefined, true),
  ];
  const app = application(rows);
  const page = openMusic(app, `/watch?v=${clipId}&list=PL-clips`, "ALL");
  app.root.queue.selectQueueItem = (entry) => {
    const index = rows.indexOf(entry);
    app.selections.push(index);
    if (app.selections.length >= 6) return;
    app.select(index);
    const target = entry.playlistPanelVideoRenderer.videoId;
    app.playerApi.loadVideoByPlayerVars({ video_id: target });
    app.setLoaded(target);
    page.playFromDom(target, clip);
  };
  page.playFromDom(clipId, clip);
  await nextTurn();
  assert.deepEqual(app.selections, [1]);
  assert.deepEqual(app.calls, [otherClip]);
});

void test("a bookmarked row disappears once Music verifies that it is a clip", async () => {
  const entry = item(clipId, undefined, true);
  const app = application([entry]);
  let hidden = false;
  app.rendered.push({
    data: entry.playlistPanelVideoRenderer,
    toggleAttribute(name, force) {
      if (name === "data-youtube-tools-video") hidden = force;
    },
  });
  const page = openMusic(app, `/watch?v=${clipId}&list=PL-mixed`);
  assert.equal(hidden, false);
  assert.equal(page.playFromDom(clipId, clip).paused, true);
  await nextTurn();
  assert.equal(hidden, true);
});

void test("an untyped row becomes visible once Music verifies that it is a song", async () => {
  const entry = item(songId);
  const app = application([entry]);
  let hidden = false;
  app.rendered.push({
    data: entry.playlistPanelVideoRenderer,
    toggleAttribute(name, force) {
      if (name === "data-youtube-tools-video") hidden = force;
    },
  });
  const page = openMusic(app, `/watch?v=${songId}&list=PL-mixed`);
  assert.equal(hidden, true);
  assert.equal(page.playFromDom(songId, song).paused, false);
  await nextTurn();
  assert.equal(hidden, false);
});

void test("Repeat All wraps to an earlier untyped song already verified by Music", async () => {
  const nextSong = "typed-song";
  const rows = [item(songId), item(nextSong, song), item(clipId, clip)];
  const app = application(rows);
  const page = openMusic(app, `/watch?v=${songId}&list=PL-one`, "ALL");
  page.playFromDom(songId, song);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: nextSong });
  app.select(2);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  app.root.queue.selectQueueItem = (entry) => {
    const index = rows.indexOf(entry);
    app.selections.push(index);
    app.select(index);
    app.playerApi.loadVideoByPlayerVars({
      video_id: entry.playlistPanelVideoRenderer.videoId,
    });
  };
  await nextTurn();
  assert.deepEqual(app.selections, [0]);
  assert.deepEqual(app.calls, [nextSong, songId]);
});

for (const direction of ["Next", "Previous"] as const) {
  void test(`${direction} follows the selected duplicate clip when the index updates after load`, async () => {
    const rows = [
      item("first-song", song),
      item(clipId, clip),
      item(songId, song),
      item(clipId, clip),
      item("last-song", song),
    ];
    const app = application(rows);
    openMusic(app, `/watch?v=${songId}&list=PL-one`);
    app.select(2);
    app.playerApi.loadVideoByPlayerVars({ video_id: songId });
    app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
    app.select(direction === "Next" ? 3 : 1);
    await nextTurn();
    assert.deepEqual(app.selections, [direction === "Next" ? 4 : 0]);
  });
}

void test("Next uses the retained occurrence after reordering duplicate songs", async () => {
  const first = item(songId, song);
  const current = item(songId, song);
  const other = item("next-song", song);
  const rejected = item(clipId, clip);
  const rows = [first, other, rejected, current, item("later-song", song)];
  const app = application(rows);
  openMusic(app, `/watch?v=${songId}&list=PL-one`);
  app.select(3);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  rows.splice(0, 4, current, rejected, other, first);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await nextTurn();
  assert.deepEqual(app.selections, [2]);
});

type QueueRow = ReturnType<typeof item>;

function recommendations(
  initial: string | undefined = "first",
  infinite = true,
) {
  const videos = Array.from({ length: 8 }, (_, i) =>
    item(i === 0 ? clipId : `clip-${i}`, clip),
  );
  const rows = [item(songId, song, false, "RDTM-recommendations"), ...videos];
  const app = application(rows);
  const requests: string[] = [];
  const state: {
    continuation: string | undefined;
    pendingFetchItemsRequest: Promise<void> | null;
  } = {
    continuation: initial,
    pendingFetchItemsRequest: null,
  };
  const queue = Object.assign(app.root.queue, state, {
    store: {
      getState: () => ({ queue: { isInfinite: infinite } }),
      dispatch({ type, payload }: { type: string; payload: number }) {
        assert.equal(type, "SET_INDEX");
        const id = rows[payload]?.playlistPanelVideoRenderer.videoId;
        assert.ok(id);
        app.select(payload);
        if (payload + 5 >= rows.length) fetchMore();
        app.playerApi.loadVideoByPlayerVars({ video_id: id });
      },
    },
  });
  let finish:
    ((additions: QueueRow[], next: string | undefined) => void) | undefined;
  let fail: (() => void) | undefined;
  function fetchMore(): void {
    const token = queue.continuation;
    if (!token || queue.pendingFetchItemsRequest) return;
    requests.push(token);
    queue.pendingFetchItemsRequest = new Promise<void>((resolve, reject) => {
      finish = (additions, next) => {
        rows.push(...additions);
        queue.continuation = next;
        queue.pendingFetchItemsRequest = null;
        resolve();
      };
      fail = () => {
        queue.pendingFetchItemsRequest = null;
        reject(new Error("continuation failed"));
      };
    });
  }
  return {
    app,
    queue,
    requests,
    fetchMore,
    requestVideo() {
      app.select(1);
      app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
    },
    finish(additions: QueueRow[], next?: string) {
      assert.ok(finish, "no native continuation started");
      finish(additions, next);
    },
    fail() {
      assert.ok(fail, "no native continuation started");
      fail();
    },
  };
}

function openRecommendations(feed: ReturnType<typeof recommendations>) {
  const page = openMusic(
    feed.app,
    `/watch?v=${songId}&list=RDTM-recommendations`,
  );
  feed.app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  return page;
}

void test("a confirmed DOM clip at the finite edge restores the previous song and player bar", async () => {
  const feed = recommendations("", false);
  const rows = feed.queue.getItems();
  rows.splice(0, rows.length, item(songId, song), item(clipId, clip));
  const page = openRecommendations(feed);
  feed.app.setLoaded(clipId);
  feed.app.select(1);
  const video = page.playFromDom(clipId, clip);
  assert.ok(video.paused);
  await nextTurn();
  assert.equal(feed.queue.getCurrentItemIndex(), 0);
  assert.deepEqual(feed.app.calls, [songId, songId]);
  assert.equal(page.blocked(), false);
});

for (const kind of ["bookmarked", "mislabeled"] as const)
  for (const confirmation of ["DOM play", "native play"] as const) {
    void test(`a ${kind} clip confirmed by ${confirmation} restores the prior song at the finite edge`, async () => {
      const feed = recommendations("", false);
      const rows = feed.queue.getItems();
      const clipRow =
        kind === "bookmarked"
          ? item(clipId, undefined, true)
          : item(clipId, song);
      rows.splice(0, rows.length, item(songId, song), clipRow);
      const page = openRecommendations(feed);
      feed.app.select(1);
      feed.app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
      feed.app.setLoaded(clipId);
      if (confirmation === "DOM play") {
        assert.equal(page.playFromDom(clipId, clip).paused, true);
      } else {
        feed.app.playerApi.getPlayerResponse = () => ({
          videoDetails: { videoId: clipId, musicVideoType: clip },
        });
        feed.app.playerApi.playVideo();
      }
      await nextTurn();
      assert.equal(feed.queue.getCurrentItemIndex(), 0);
      assert.deepEqual(feed.app.calls, [songId, clipId, songId]);
      assert.equal(page.blocked(), false);
    });
  }

void test("the last song requests native continuation past a hidden tail without restarting", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, ["first"]);
  assert.equal(
    feed.queue.getCurrentItemIndex(),
    0,
    "the current song remains selected",
  );
  assert.deepEqual(
    feed.app.calls,
    [songId],
    "native probing must not load media",
  );
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [9]);
});

void test("repeated Next waits for an existing native continuation", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.fetchMore();
  for (let i = 0; i < 3; i++) {
    feed.requestVideo();
    await nextTurn();
    assert.equal(feed.queue.getCurrentItemIndex(), 0);
  }
  assert.deepEqual(feed.requests, ["first"]);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [9]);
});

void test("the native player can resume the same song while continuation is pending", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.app.setLoaded(songId);
  feed.requestVideo();
  await nextTurn();
  feed.app.playerApi.playVideo();
  assert.deepEqual(feed.app.calls, [songId, "play"]);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [9]);
});

void test("resuming the same song in the native Next turn does not cancel the refill", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.app.setLoaded(songId);
  feed.requestVideo();
  feed.app.playerApi.playVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, ["first"]);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [9]);
});

void test("cueing the rejected clip in the native Next turn does not supersede its refill", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  feed.app.playerApi.cueVideoByPlayerVars({ video_id: clipId });
  await nextTurn();
  assert.deepEqual(feed.requests, ["first"]);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [9]);
});

void test("Next still follows a recommendation continuation in the mini-player on Home", async () => {
  const feed = recommendations();
  openMusic(feed.app, "/");
  feed.app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, ["first"]);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [9]);
});

void test("a continuation containing only clips follows a new continuation once", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  feed.finish([item("extra-video", clip)], "second");
  await nextTurn();
  assert.deepEqual(feed.requests, ["first", "second"]);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [10]);
});

void test("a playlist update can replace the hidden tail before adding the next song", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  feed.queue.getItems().splice(1);
  feed.finish([item("replacement-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, [1]);
  assert.deepEqual(feed.app.calls, [songId]);
});

for (const outcome of [
  "no continuation",
  "same continuation",
  "request failure",
] as const) {
  void test(`the current song stays selected after ${outcome}`, async () => {
    const feed = recommendations(outcome === "no continuation" ? "" : "first");
    openRecommendations(feed);
    feed.requestVideo();
    await nextTurn();
    if (outcome === "same continuation")
      feed.finish([item("extra-video", clip)], "first");
    if (outcome === "request failure") feed.fail();
    await nextTurn();
    assert.deepEqual(
      feed.requests,
      outcome === "no continuation" ? [] : ["first"],
    );
    assert.equal(feed.queue.getCurrentItemIndex(), 0);
    assert.deepEqual(feed.app.calls, [songId]);
    assert.deepEqual(feed.app.selections, []);
  });
}

void test("Next cannot repeatedly request an already completed continuation token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  feed.finish([item("extra-video", clip)], "first");
  await nextTurn();
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, ["first"]);
  assert.equal(feed.queue.getCurrentItemIndex(), 0);
});

void test("a late continuation cannot jump from another occurrence of the rejected clip", async () => {
  const feed = recommendations();
  feed.queue.getItems()[2] = item(clipId, clip);
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  feed.app.select(2);
  feed.finish([item("next-song", song)]);
  await nextTurn();
  assert.deepEqual(feed.app.selections, []);
});

for (const interruption of [
  "another mix",
  "another URL in the same mix",
  "another song",
  "queue replaced",
] as const) {
  void test(`a late continuation cannot change playback after ${interruption}`, async () => {
    const feed = recommendations();
    const page = openRecommendations(feed);
    feed.requestVideo();
    await nextTurn();
    if (interruption === "another mix")
      page.navigate(`/watch?v=${songId}&list=RDTM-other`);
    if (interruption === "another URL in the same mix")
      page.navigate("/watch?v=other-song&list=RDTM-recommendations");
    if (interruption === "another song") {
      feed.queue.getItems().push(item("chosen-song", song));
      feed.app.select(9);
      feed.app.playerApi.loadVideoByPlayerVars({ video_id: "chosen-song" });
    }
    if (interruption === "queue replaced")
      page.replace(application([item("chosen-song", song)]));
    feed.finish([item("next-song", song)]);
    await nextTurn();
    assert.deepEqual(feed.app.selections, []);
  });
}

void test("a finite playlist keeps its usual end behavior", async () => {
  const feed = recommendations("first", false);
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, []);
  assert.deepEqual(feed.app.selections, []);
});

void test("a finite playlist skips a clip when Next also resumes the loaded song", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("next-song", song),
  ]);
  openMusic(app, `/watch?v=${songId}&list=PL-finite`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.setLoaded(songId);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  app.playerApi.playVideo();
  await nextTurn();
  assert.deepEqual(app.selections, [2]);
});

void test("Next skips a clip while resuming the loaded song in a queue without a playlist ID", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("next-song", song),
  ]);
  openMusic(app, `/watch?v=${songId}`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.setLoaded(songId);
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  app.playerApi.playVideo();
  await nextTurn();
  assert.deepEqual(app.selections, [2]);
});

for (const edge of ["start", "end"] as const) {
  void test(`a hidden finite ${edge} keeps the song selected for the next manual change`, async () => {
    const feed = recommendations("", false);
    const rows = feed.queue.getItems();
    const first = item(songId, song);
    const second = item("second-song", song);
    rows.splice(
      0,
      rows.length,
      item("start-clip", clip),
      first,
      second,
      item("end-clip", clip),
    );
    const origin = edge === "start" ? 1 : 2;
    const target = edge === "start" ? 0 : 3;
    const id = edge === "start" ? songId : "second-song";
    const clipIdAtEdge = edge === "start" ? "start-clip" : "end-clip";
    openMusic(feed.app, `/watch?v=${id}&list=PL-finite`);
    feed.app.select(origin);
    feed.app.playerApi.loadVideoByPlayerVars({ video_id: id });
    feed.app.setLoaded(id);
    feed.app.select(target);
    feed.app.playerApi.loadVideoByPlayerVars({ video_id: clipIdAtEdge });
    await nextTurn();
    assert.equal(feed.queue.getCurrentItemIndex(), origin);
    assert.deepEqual(
      feed.app.calls,
      [id],
      "restoring the selection does not reload it",
    );
    assert.deepEqual(feed.requests, []);
  });
}

void test("a direct clip opened before a queued skip cannot resume the old playlist", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("next-song", song),
  ]);
  const page = openMusic(app, `/watch?v=${songId}&list=PL-finite`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.navigate(`/watch?v=${clipId}`);
  await nextTurn();
  assert.deepEqual(app.selections, []);
  assert.equal(page.blocked(), true);
});

void test("preparing a clip does not select a song or interrupt Next", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("next-song", song),
  ]);
  openMusic(app, `/watch?v=${songId}&list=PL-finite`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.playerApi.cueVideoByPlayerVars({ video_id: clipId });
  await nextTurn();
  assert.deepEqual(app.selections, []);
});

void test("an allowed preload cannot supersede an explicit Next through a clip", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("next-song", song),
  ]);
  openMusic(app, `/watch?v=${songId}&list=PL-finite`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  app.playerApi.cueVideoByPlayerVars({ video_id: "next-song" });
  await nextTurn();
  assert.deepEqual(app.selections, [2]);
});

void test("opening another playlist cancels a skip even before any continuation starts", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("next-song", song),
  ]);
  const page = openMusic(app, `/watch?v=${songId}&list=PL-finite`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  page.navigate("/watch?v=new-playlist-song&list=PL-other");
  await nextTurn();
  assert.deepEqual(app.selections, []);
});

void test("Previous skips a clip even when the native player resumes the loaded song", async () => {
  const app = application([
    item(songId, song),
    item(clipId, clip),
    item("end-song", song),
  ]);
  openMusic(app, "/watch?v=end-song&list=PL-finite");
  app.select(2);
  app.playerApi.loadVideoByPlayerVars({ video_id: "end-song" });
  app.setLoaded("end-song");
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  app.playerApi.playVideo();
  await nextTurn();
  assert.deepEqual(app.selections, [0]);
});

void test("an unchanged song URL can use a queue whose mix ID is only in the native metadata", async () => {
  const app = application([
    item(songId, song, false, "RDAMVM-seed"),
    item(clipId, clip),
    item("next-song", song),
  ]);
  openMusic(app, `/watch?v=${songId}`);
  app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  app.select(1);
  app.playerApi.loadVideoByPlayerVars({ video_id: clipId });
  await nextTurn();
  assert.deepEqual(app.selections, [2]);
});

void test("Next does not revisit a completed token in a continuation cycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  feed.finish([item("extra-video-one", clip)], "second");
  await nextTurn();
  feed.finish([item("extra-video-two", clip)], "first");
  await nextTurn();
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, ["first", "second"]);
  assert.equal(feed.queue.getCurrentItemIndex(), 0);
});

void test("Repeat All wraps an infinite queue before requesting a continuation", async () => {
  const feed = recommendations();
  openMusic(feed.app, `/watch?v=${songId}&list=RDTM-recommendations`, "ALL");
  feed.app.playerApi.loadVideoByPlayerVars({ video_id: songId });
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, []);
  assert.deepEqual(feed.app.selections, [0]);
});

void test("Previous never requests a forward continuation", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.queue.getItems().push(item("end-song", song));
  feed.app.select(9);
  feed.app.playerApi.loadVideoByPlayerVars({ video_id: "end-song" });
  feed.app.select(8);
  feed.app.playerApi.loadVideoByPlayerVars({ video_id: "clip-7" });
  await nextTurn();
  assert.deepEqual(feed.requests, []);
  assert.deepEqual(feed.app.selections, [0]);
});

void test("cues and enqueue preloads do not start a continuation at the hidden tail", async () => {
  const feed = recommendations();
  openRecommendations(feed);
  feed.app.playerApi.cueVideoByPlayerVars({ video_id: clipId });
  feed.app.playerApi.enqueueVideoByPlayerVars({ video_id: clipId });
  await nextTurn();
  assert.deepEqual(feed.requests, []);
  assert.deepEqual(feed.app.calls, [songId]);
});

void test("a continuation that arrives after the timeout cannot change tracks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const feed = recommendations();
  openRecommendations(feed);
  feed.requestVideo();
  await nextTurn();
  assert.deepEqual(feed.requests, ["first"]);
  t.mock.timers.tick(15000);
  feed.finish([item("late-song", song)]);
  await nextTurn();
  assert.equal(feed.queue.getCurrentItemIndex(), 0);
  assert.deepEqual(feed.app.selections, []);
});

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
