import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { candidate, freshPage, hosts } from "./harness.ts";
import type { Host } from "./harness.ts";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({
    args: ["--disable-extensions", "--mute-audio"],
  });
});
after(async () => {
  await browser?.close();
});

const panelSelector = "ytmusic-tab-renderer";
const plainSelector = "[data-youtube-tools-plain-lyrics]";
const rowSelector = ".youtube-tools-lyrics-viewport button";
const progressProperty = "--youtube-tools-lyrics-progress";
const fixture = `<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { background: #000; color: #fff }
    ytmusic-app, ytmusic-player-page, ytmusic-description-shelf-renderer { display: block }
    ytmusic-tab-renderer { display: block; height: 240px; max-width: 500px; overflow: auto }
    .right-controls-buttons { display: flex }
    .volume { display: block; width: 36px; height: 36px }
  </style>
</head><body>
  <ytmusic-app>
    <ytmusic-player-bar><div class="right-controls-buttons"><yt-icon-button class="volume"></yt-icon-button></div></ytmusic-player-bar>
    <ytmusic-player-page player-page-open>
      <div id="movie_player"><video class="html5-main-video" muted></video></div>
      <ytmusic-tab-renderer id="tab-renderer">
        <ytmusic-description-shelf-renderer is-track-lyrics-page>
          <div class="description">${"Example line<br>".repeat(32)}</div>
          <div class="footer">Source: Example</div>
        </ytmusic-description-shelf-renderer>
      </ytmusic-tab-renderer>
    </ytmusic-player-page>
  </ytmusic-app>
</body></html>`;

const browseEndpoint = {
  browseId: "MPLYtabcdefghijk",
  browseEndpointContextSupportedConfigs: {
    browseEndpointContextMusicConfig: {
      pageType: "MUSIC_PAGE_TYPE_TRACK_LYRICS",
    },
  },
};
const watchResult = {
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [{ tabRenderer: { endpoint: { browseEndpoint } } }],
        },
      },
    },
  },
};
const timedLyrics = {
  contents: {
    elementRenderer: {
      newElement: {
        type: {
          componentType: {
            model: {
              timedLyricsModel: {
                lyricsData: {
                  timedLyricsData: ["First line", "Second line", "Third line"].map(
                    (lyricLine, index) => ({
                      lyricLine,
                      cueRange: {
                        startTimeMilliseconds: index * 1000,
                        endTimeMilliseconds: (index + 1) * 1000,
                      },
                    }),
                  ),
                },
              },
            },
          },
        },
      },
    },
  },
};

async function withLyrics(
  host: Host,
  synced: boolean,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  await freshPage(browser, host, async (page, context) => {
    context.setDefaultTimeout(5000);
    await context.route("https://music.youtube.com/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/youtubei/v1/next")
        return route.fulfill({ json: watchResult });
      if (pathname === "/youtubei/v1/browse")
        return route.fulfill({ json: synced ? timedLyrics : {} });
      if (pathname === "/watch")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: fixture,
        });
      return route.abort();
    });
    await candidate(context);
    await page.goto("https://music.youtube.com/watch?v=abcdefghijk");
    await page.evaluate(({ endpoint, selector }) => {
      const panel = document.querySelector(selector);
      const video = document.querySelector("video");
      if (!panel || !video) throw new Error("Missing music lyrics fixture");
      Reflect.set(window, "ytcfg", { get: () => "1.0.0" });
      Reflect.set(panel, "data", { endpoint: { browseEndpoint: endpoint } });
      Object.defineProperties(video, {
        currentTime: { value: 0, writable: true },
        duration: { value: 200 },
      });
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    }, { endpoint: browseEndpoint, selector: panelSelector });
    await run(page);
  }, { reducedMotion: "no-preference" });
}

for (const host of hosts) {
  void test(`plain lyrics start at the cue anchor and scroll without a scrollbar (${host})`, () =>
    withLyrics(host, false, async (page) => {
      const panel = page.locator(plainSelector);
      await panel.waitFor();
      const result = await panel.evaluate((element) => {
        const shelf = element.querySelector("ytmusic-description-shelf-renderer");
        const text = shelf?.querySelector(".description");
        const video = document.querySelector("video");
        if (!shelf || !text || !video) throw new Error("Missing plain lyrics");
        const firstLineCenter = text.getBoundingClientRect().top
          - element.getBoundingClientRect().top + parseFloat(getComputedStyle(text).lineHeight) / 2;
        const range = element.scrollHeight - element.clientHeight;
        const position = (offset: number) => {
          video.currentTime = offset * video.duration / range;
          video.dispatchEvent(new Event("timeupdate"));
          return { pixel: element.scrollTop, top: shelf.getBoundingClientRect().top };
        };
        return {
          scrollbar: getComputedStyle(element).scrollbarWidth,
          scrollable: range > 11,
          anchorError: Math.abs(firstLineCenter - 0.42 * element.clientHeight),
          first: position(10.25),
          second: position(10.75),
        };
      });
      assert.equal(result.scrollbar, "none");
      assert.equal(result.scrollable, true);
      assert.ok(result.anchorError < 1, `First line is ${result.anchorError}px from the cue anchor`);
      assert.equal(result.first.pixel, result.second.pixel);
      assert.ok(Math.abs(result.first.top - result.second.top - 0.5) < 0.05);
    }));
}

void test("synced lyrics keep their paint on cue changes and animate hover and fill controls", () =>
  withLyrics("www.youtube.com", true, async (page) => {
    const rows = page.locator(rowSelector);
    const current = rows.nth(0);
    const next = rows.nth(1);
    const toggle = page.getByRole("button", { name: "Lyric word fill" });

    await current.waitFor();
    assert.equal(await current.getAttribute("aria-current"), "true");
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(
      await toggle.evaluate((button) =>
        button.nextElementSibling?.matches("yt-icon-button.volume")
      ),
      true,
    );
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    assert.equal(await current.getAttribute("aria-current"), "true");
    const fill = () =>
      current.locator("span").evaluate((span) => getComputedStyle(span).backgroundImage);
    assert.equal(await fill(), "none");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.match(await fill(), /^linear-gradient/);

    const normal = await next.evaluate((row) => {
      row.addEventListener("transitionrun", (event) => {
        if (event instanceof TransitionEvent && event.propertyName === "color")
          row.setAttribute("data-test-hover-transition", "");
      });
      return getComputedStyle(row).color;
    });
    assert.equal(normal, "rgb(115, 115, 115)");
    await next.hover();
    await next.and(page.locator("[data-test-hover-transition]")).waitFor();
    await page.waitForFunction(
      (selector) => {
        const row = document.querySelector(selector);
        return row && getComputedStyle(row).color === "rgb(185, 185, 185)";
      },
      "[data-test-hover-transition]",
    );
    await page.mouse.move(0, 0);

    const cue = await page.evaluate(({ selector, progress }) => {
      const [previous, following] = document.querySelectorAll(selector);
      const video = document.querySelector("video");
      const previousText = previous?.querySelector("span");
      const followingText = following?.querySelector("span");
      if (!previous || !following || !video || !previousText || !followingText)
        throw new Error("Missing synced lyric cues");
      const setTime = (time: number) => {
        video.currentTime = time;
        video.dispatchEvent(new Event("timeupdate"));
      };
      const readProgress = () => parseFloat(getComputedStyle(previous).getPropertyValue(progress));
      setTime(0.7);
      const before = readProgress();
      setTime(1.01);
      const outgoing = readProgress();
      const clips = [previousText, followingText].map((span) => getComputedStyle(span).backgroundClip);
      const fade = previous.getAnimations().find(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === progress,
      );
      if (fade) {
        fade.pause();
        fade.currentTime = 120;
      }
      const middle = readProgress();
      fade?.finish();
      return {
        before, outgoing, middle, clips,
        after: readProgress(),
        followingActive: following.getAttribute("aria-current"),
        previousActive: previous.getAttribute("aria-current"),
      };
    }, { selector: rowSelector, progress: progressProperty });
    assert.equal(cue.before, 70);
    assert.ok(cue.outgoing > 0);
    assert.ok(cue.middle > 0 && cue.middle < cue.before);
    assert.equal(cue.after, 0);
    assert.deepEqual(cue.clips, ["text", "text"]);
    assert.equal(cue.followingActive, "true");
    assert.equal(cue.previousActive, null);
  }));

