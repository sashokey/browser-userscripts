import { activeLyricIndex } from "./music-lyrics-data.ts";
import type { TimedLyric } from "./music-lyrics-data.ts";

export const activeLyricsPanel = "data-youtube-tools-synced-lyrics";
const viewportClass = "youtube-tools-lyrics-viewport";
const listClass = "youtube-tools-lyrics-lines";
const sourceClass = "youtube-tools-lyrics-source";
const anchor = 0.42;
const followDelay = 2000;
const transitionDuration = 360;

export function styleLyrics(shelf: string): void {
  GM_addStyle(`
    ytmusic-tab-renderer[${activeLyricsPanel}] { position:relative; overflow:hidden!important }
    [${activeLyricsPanel}] ${shelf} { position:absolute; inset:auto 0 0; pointer-events:none }
    [${activeLyricsPanel}] ${shelf} :is(.description,#description-button,.footer) { display:none!important }
    .${viewportClass} { position:absolute; inset:0; overflow:hidden auto; overscroll-behavior-y:contain; overflow-anchor:none; scroll-behavior:auto; scrollbar-width:none }
    .${viewportClass}::-webkit-scrollbar { display:none }
    .${listClass} {
      position:relative; display:grid; gap:clamp(12px,2vh,24px); color:#fff;
      padding-inline:clamp(16px,3vw,36px); font-size:clamp(23px,3.5vw,32px); font-weight:700; line-height:1.18
    }
    .${listClass} > button {
      background:none; border:0; padding:0; font:inherit; color:inherit; text-align:start;
      min-width:0; white-space:pre-line; overflow-wrap:anywhere; cursor:pointer;
      opacity:.45; transition:opacity 240ms ease-out
    }
    .${listClass} > [aria-current=true] { opacity:1 }
    .${listClass} > button:focus-visible { outline:2px solid currentColor; outline-offset:4px }
    .${sourceClass} { color:var(--ytmusic-color-light-secondary,#aaa); padding:0 clamp(16px,3vw,36px) 12px; font-size:14px }
    @media (prefers-reduced-motion: reduce) { .${listClass} > button { transition:none } }
  `);
}

export function renderLyrics(
  panel: HTMLElement,
  shelf: HTMLElement,
  video: HTMLVideoElement,
  lyrics: readonly TimedLyric[],
  signal: AbortSignal,
): HTMLElement {
  const viewport = document.createElement("div");
  viewport.className = viewportClass;
  viewport.tabIndex = 0;
  const list = document.createElement("div");
  list.className = listClass;
  const rows = lyrics.map(({ text }) => {
    const row = document.createElement("button");
    row.type = "button";
    row.textContent = text;
    return row;
  });
  list.append(...rows);
  viewport.append(list);
  const footer = document.createElement("div");
  footer.className = sourceClass;
  function updateSource(): void {
    const source = shelf.querySelector(".footer")?.textContent?.trim();
    if (!source) {
      footer.remove();
      return;
    }
    if (footer.textContent !== source) footer.textContent = source;
    if (footer.parentElement !== viewport) viewport.append(footer);
  }
  updateSource();
  const sourceObserver = new MutationObserver(updateSource);
  sourceObserver.observe(shelf, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  panel.append(viewport);
  panel.scrollTop = 0;
  panel.setAttribute(activeLyricsPanel, "");

  let active: HTMLButtonElement | undefined;
  let resumeTimer: number | undefined;
  let frame: number | undefined;
  let position = viewport.scrollTop;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function cancelMotion(): void {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  }

  function scrollTo(top: number): void {
    viewport.scrollTop = top;
    position = viewport.scrollTop;
  }

  function align(row: HTMLElement, animate: boolean): void {
    cancelMotion();
    const from = viewport.scrollTop;
    const top = Math.max(
      0,
      row.offsetTop + row.offsetHeight / 2 - viewport.clientHeight * anchor,
    );
    if (!animate || reducedMotion.matches || Math.abs(from - top) < 1) {
      scrollTo(top);
      return;
    }
    let started: number | undefined;
    function step(now: number): void {
      started ??= now;
      const progress = Math.min(1, (now - started) / transitionDuration);
      const eased = progress * progress * (3 - 2 * progress);
      scrollTo(from + (top - from) * eased);
      frame = progress < 1 ? window.requestAnimationFrame(step) : undefined;
    }
    frame = window.requestAnimationFrame(step);
  }

  function update(animate: boolean, force = false): void {
    const row = rows[activeLyricIndex(lyrics, video.currentTime * 1000)];
    if (!row || !viewport.clientHeight) return;
    const changed = row !== active;
    if (changed) {
      active?.removeAttribute("aria-current");
      row.setAttribute("aria-current", "true");
      active = row;
    }
    if (resumeTimer === undefined && (changed || force)) align(row, animate);
  }

  function pauseFollowing(): void {
    cancelMotion();
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(resumeFollowing, followDelay);
  }

  function resumeFollowing(): void {
    window.clearTimeout(resumeTimer);
    resumeTimer = undefined;
    update(true, true);
  }

  function resize(): void {
    const first = rows[0];
    const last = rows.at(-1);
    const height = viewport.clientHeight;
    if (!first || !last || !height) return;
    list.style.paddingBlockStart = `${Math.max(0, height * anchor - first.offsetHeight / 2)}px`;
    list.style.paddingBlockEnd = `${Math.max(0, height * (1 - anchor) - last.offsetHeight / 2)}px`;
    update(false, true);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  observer.observe(list);
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      sourceObserver.disconnect();
      cancelMotion();
      window.clearTimeout(resumeTimer);
    },
    { once: true },
  );
  for (const event of ["wheel", "touchmove"])
    viewport.addEventListener(event, pauseFollowing, { passive: true, signal });
  viewport.addEventListener(
    "scroll",
    () => {
      if (position === viewport.scrollTop) return;
      position = viewport.scrollTop;
      pauseFollowing();
    },
    { passive: true, signal },
  );
  function lyricFor(target: EventTarget | null): TimedLyric | undefined {
    if (target instanceof HTMLButtonElement)
      return lyrics[rows.indexOf(target)];
  }
  function seek(lyric: TimedLyric): void {
    video.currentTime = lyric.start / 1000;
    resumeFollowing();
  }
  list.addEventListener(
    "click",
    (event) => {
      const lyric = lyricFor(event.target);
      if (lyric) seek(lyric);
    },
    { signal },
  );
  function activateWithKey(event: KeyboardEvent): void {
    if (
      (event.key !== " " && event.key !== "Enter") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const lyric = lyricFor(event.target);
    if (!lyric) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat) seek(lyric);
  }
  for (const event of ["keydown", "keyup"] as const)
    window.addEventListener(event, activateWithKey, { capture: true, signal });
  for (const event of ["timeupdate", "seeked"])
    video.addEventListener(
      event,
      () => {
        update(true);
      },
      { signal },
    );
  resize();
  return viewport;
}
