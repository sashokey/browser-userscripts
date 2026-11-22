import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const file =
  process.env.YOUTUBE_TOOLS_ARTIFACT === "youtube-tools.debug.js"
    ? "youtube-tools.debug.js"
    : "youtube-tools.user.js";
const code = await readFile(new URL(`../${file}`, import.meta.url), "utf8");

void test("a replaced native play method still blocks a directly opened clip", () => {
  const nativeCalls: string[] = [];
  const videoId = "dQw4w9WgXcQ";
  const playerApi = { playVideo: () => nativeCalls.push("initial") };
  const item = {
    playlistPanelVideoRenderer: {
      videoId,
      navigationEndpoint: {
        watchEndpoint: {
          videoId,
          watchEndpointMusicSupportedConfigs: {
            watchEndpointMusicConfig: {
              musicVideoType: "MUSIC_VIDEO_TYPE_OMV",
            },
          },
        },
      },
    },
  };
  const app = {
    querySelectorAll: () => [],
    queue: {
      playerApi,
      getItems: () => [item],
      getCurrentItemIndex: () => 0,
    },
  };
  let publish: ((records: unknown[]) => void) | undefined;
  class Observer {
    constructor(callback: (records: unknown[]) => void) {
      publish = callback;
    }
    observe() {}
    disconnect() {}
  }
  const window = {
    get top() {
      return window;
    },
  };
  runInNewContext(code, {
    window,
    location: {
      hostname: "music.youtube.com",
      pathname: "/watch",
      search: `?v=${videoId}`,
    },
    document: {
      querySelector: () => app,
      documentElement: { toggleAttribute() {} },
      addEventListener() {},
    },
    GM_addStyle() {},
    MutationObserver: Observer,
    queueMicrotask,
    URLSearchParams,
  });
  playerApi.playVideo();
  assert.equal(nativeCalls.length, 0);
  playerApi.playVideo = () => nativeCalls.push("replacement");
  assert.ok(publish);
  publish([]);
  playerApi.playVideo();
  assert.deepEqual(nativeCalls, []);
});
