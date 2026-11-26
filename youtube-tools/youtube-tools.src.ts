// ==UserScript==
// @name         YouTube Tools
// @namespace    https://github.com/sashokey/browser-userscripts
// @version      6
// @description  Quick feedback, watched-video filtering, audio-only playback, manual playlist navigation, and track filtering, library shortcuts and synced lyrics on YouTube Music.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @run-at       document-start
// @inject-into  page
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        unsafeWindow
// @homepageURL  https://github.com/sashokey/browser-userscripts
// @updateURL    https://raw.githubusercontent.com/sashokey/browser-userscripts/master/youtube-tools/youtube-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/sashokey/browser-userscripts/master/youtube-tools/youtube-tools.user.js
// @license      GPL-3.0-only
// ==/UserScript==

import { audio } from "./src/audio.ts";
import { mobile, ready } from "./src/dom.ts";
import { feedback } from "./src/feedback.ts";
import { music } from "./src/music.ts";
import { playlist } from "./src/playlist.ts";
import { settings } from "./src/settings.ts";
import { initializePreferences } from "./src/state.ts";
import { watched } from "./src/watched.ts";

const key = Symbol.for("sashokey.youtube-tools");
const musicHost = location.hostname === "music.youtube.com";

if (
  !Reflect.has(document, key) &&
  window.top === window &&
  (mobile || musicHost || location.hostname === "www.youtube.com") &&
  !location.pathname.startsWith("/embed/")
) {
  Object.defineProperty(document, key, { value: true });
  if (musicHost) music();
  else {
    initializePreferences();
    audio();
    playlist();
    ready(() => {
      settings();
      watched();
      feedback();
    });
  }
}
