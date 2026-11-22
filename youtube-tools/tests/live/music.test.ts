import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { candidate } from "../harness.ts";
import { musicRows, onlyTracks } from "./music-page.ts";

const search =
  "https://music.youtube.com/search?q=Never+Gonna+Give+You+Up&hl=en";
const rows =
  "ytmusic-two-row-item-renderer,ytmusic-responsive-list-item-renderer,ytmusic-card-shelf-renderer";

async function results(browser: Browser, enabled: boolean) {
  const context = await browser.newContext({ locale: "en-US" });
  try {
    if (enabled) await candidate(context);
    const page = await context.newPage();
    await page.goto(search, { waitUntil: "domcontentloaded", timeout: 25000 });
    const reject = page
      .getByRole("button", { name: "Reject all", exact: true })
      .first();
    if (await reject.isVisible()) await reject.click();
    assert.equal(new URL(page.url()).hostname, "music.youtube.com");
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length >= 4,
      rows,
      { timeout: 15000 },
    );
    if (enabled)
      await page.locator("[data-youtube-tools-video]").first().waitFor({
        state: "attached",
        timeout: 7000,
      });
    return await page.evaluate(musicRows, rows);
  } finally {
    await context.close();
  }
}

void test(
  "YouTube Music search keeps songs and hides videos from the same public query",
  { timeout: 90000 },
  async () => {
    const browser = await chromium.launch({
      args: ["--disable-extensions", "--mute-audio"],
    });
    try {
      const stock = await results(browser, false);
      assert.ok(stock.visibleTracks > 0);
      assert.ok(stock.visibleClips > 0);
      onlyTracks(await results(browser, true));
    } finally {
      await browser.close();
    }
  },
);
