import { activeLyricIndex } from "./music-lyrics-data.ts";
import type { TimedLyric } from "./music-lyrics-data.ts";

export const activeLyricsPanel = "data-youtube-tools-synced-lyrics";
export const pendingLyricsPanel = "data-youtube-tools-lyrics-pending";
export const plainLyricsPanel = "data-youtube-tools-plain-lyrics";
const shelfSelector =
  "ytmusic-description-shelf-renderer[is-track-lyrics-page]";
const viewportClass = "youtube-tools-lyrics-viewport";
const listClass = "youtube-tools-lyrics-lines";
const sourceClass = "youtube-tools-lyrics-source";
const instrumentalClass = "youtube-tools-lyrics-instrumental";
const progressProperty = "--youtube-tools-lyrics-progress";
const anchor = 0.42;
const followDelay = 2000;
const plainFollowDelay = 4000;
const minimumInstrumentalGap = 3000;
const transitionDuration = 360;
const cueTransitionDuration = 340;
const cueContinuityLimit = 120;

export function styleLyrics(): void {
  GM_addStyle(`
    ytmusic-tab-renderer[${activeLyricsPanel}] { position:relative; overflow:hidden!important }
    [${activeLyricsPanel}] ${shelfSelector} { position:absolute; inset:auto 0 0; pointer-events:none }
    [${activeLyricsPanel}] ${shelfSelector} :is(.description,#description-button,.footer) { display:none!important }
    [${pendingLyricsPanel}] { position:relative }
    [${pendingLyricsPanel}] ${shelfSelector} { visibility:hidden!important }
    [${pendingLyricsPanel}]::before {
      content:""; display:block; position:absolute; inset:24px auto auto 50%;
      width:24px; height:24px; margin-inline-start:-12px; border:2px solid #666;
      border-top-color:#fff; border-radius:50%; animation:youtube-tools-lyrics-loading .8s linear infinite
    }
    @keyframes youtube-tools-lyrics-loading { to { transform:rotate(360deg) } }
    .${viewportClass} { position:absolute; inset:0; overflow:hidden auto; overscroll-behavior-y:contain; overflow-anchor:none; scroll-behavior:auto; scrollbar-width:none }
    .${viewportClass}::-webkit-scrollbar { display:none }
    ytmusic-tab-renderer[${plainLyricsPanel}] { overflow-anchor:none; scroll-behavior:auto }
    .${listClass}, [${plainLyricsPanel}] ${shelfSelector} .description {
      color:#fff; font-size:clamp(23px,3.5vw,32px); font-weight:700; line-height:1.18
    }
    .${listClass} {
      position:relative; display:grid; gap:clamp(12px,2vh,24px);
      padding-inline:clamp(16px,3vw,36px)
    }
    .${listClass} > button {
      background:none; border:0; padding:0; font:inherit; color:inherit; text-align:start;
      min-width:0; white-space:pre-line; overflow-wrap:anywhere; cursor:pointer;
      opacity:.45; scale:.97; transform-origin:left center;
      transition:opacity 240ms ease-out,scale 240ms ease-in-out
    }
    .${listClass} > button:dir(rtl) { transform-origin:right center }
    .${listClass} > [aria-current=true] { opacity:1; scale:1 }
    .${listClass} > button > span { pointer-events:none }
    .${listClass} > button:focus-visible { outline:2px solid currentColor; outline-offset:4px }
    .${instrumentalClass} { justify-self:start; direction:ltr; font-variant-numeric:tabular-nums }
    .${instrumentalClass}[hidden] { display:none }
    @supports (background-clip:text) {
      .${listClass} > [aria-current=true] > span, .${instrumentalClass} {
        background-image:linear-gradient(90deg,#fff var(${progressProperty},100%),#ffffff73 var(${progressProperty},100%));
        background-clip:text; color:transparent
      }
    }
    .${sourceClass} { color:var(--ytmusic-color-light-secondary,#aaa); padding:0 clamp(16px,3vw,36px) 12px; font-size:14px }
    @media (prefers-reduced-motion: reduce), (forced-colors: active) {
      .${listClass} > [aria-current=true] > span, .${instrumentalClass} { background:none; color:inherit }
    }
    @media (prefers-reduced-motion: reduce) {
      .${listClass} > button { transition:none }
      [${pendingLyricsPanel}]::before { animation:none }
    }
  `);
}

function followScroll(
  viewport: HTMLElement,
  destination: () => number | undefined,
  delay: number,
  reducedMotion: MediaQueryList,
  signal: AbortSignal,
  onManualScroll?: () => void,
) {
  let resumeTimer: number | undefined;
  let frame: number | undefined;
  let position = viewport.scrollTop;

  function cancelMotion(): void {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  }

  function scrollTo(top: number): void {
    viewport.scrollTop = top;
    position = viewport.scrollTop;
  }

  function follow(
    animate: boolean,
    startStagger?: (distance: number) => void,
  ): void {
    if (
      resumeTimer !== undefined ||
      (!animate && frame !== undefined && !reducedMotion.matches)
    )
      return;
    const top = destination();
    if (top === undefined) return;
    cancelMotion();
    const from = viewport.scrollTop;
    const distance = top - from;
    if (!animate || reducedMotion.matches || Math.abs(distance) < 1) {
      if (from !== top) scrollTo(top);
      return;
    }
    const stagger =
      startStagger && distance > 0 && distance <= viewport.clientHeight;
    if (stagger) startStagger(distance);
    const duration = stagger ? cueTransitionDuration : transitionDuration;
    let started: number | undefined;
    function step(now: number): void {
      started ??= now;
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      const target = destination() ?? from;
      scrollTo(from + (target - from) * eased);
      frame = progress < 1 ? window.requestAnimationFrame(step) : undefined;
    }
    frame = window.requestAnimationFrame(step);
  }

  function resume(): void {
    window.clearTimeout(resumeTimer);
    resumeTimer = undefined;
    follow(true);
  }

  function pause(): void {
    cancelMotion();
    onManualScroll?.();
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(resume, delay);
  }

  for (const event of ["wheel", "touchmove"])
    viewport.addEventListener(event, pause, { passive: true, signal });
  viewport.addEventListener(
    "scroll",
    () => {
      if (position === viewport.scrollTop) return;
      position = viewport.scrollTop;
      pause();
    },
    { passive: true, signal },
  );
  signal.addEventListener(
    "abort",
    () => {
      cancelMotion();
      window.clearTimeout(resumeTimer);
    },
    { once: true },
  );
  return { follow, resume };
}

function watchPosition(
  video: HTMLVideoElement,
  update: () => void,
  animate: () => boolean,
  signal: AbortSignal,
): void {
  let frame: number | undefined;
  function cancel(): void {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  }
  function refresh(): void {
    update();
    if (video.paused || video.ended || video.readyState < 2 || !animate())
      cancel();
    else frame ??= window.requestAnimationFrame(tick);
  }
  function tick(): void {
    frame = undefined;
    refresh();
  }
  for (const event of [
    "timeupdate",
    "seeking",
    "seeked",
    "playing",
    "waiting",
    "pause",
    "ended",
    "durationchange",
  ])
    video.addEventListener(event, refresh, { signal });
  signal.addEventListener("abort", cancel, { once: true });
  refresh();
}

export function followPlainLyrics(
  panel: HTMLElement,
  video: HTMLVideoElement,
  signal: AbortSignal,
): () => void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const following = followScroll(
    panel,
    () => {
      const { currentTime, duration } = video;
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !Number.isFinite(currentTime)
      )
        return;
      const range = Math.max(0, panel.scrollHeight - panel.clientHeight);
      return range * Math.min(1, Math.max(0, currentTime / duration));
    },
    plainFollowDelay,
    reducedMotion,
    signal,
  );
  const update = () => following.follow(false);
  const observer = new ResizeObserver(update);
  observer.observe(panel);
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  watchPosition(video, update, () => !reducedMotion.matches, signal);
  return update;
}

function fillText(
  element: HTMLElement,
  time: number,
  start: number,
  end: number,
): void {
  const fraction = end > start ? (time - start) / (end - start) : 1;
  const fill = `${Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10}%`;
  if (element.style.getPropertyValue(progressProperty) !== fill)
    element.style.setProperty(progressProperty, fill);
}

export function renderLyrics(
  panel: HTMLElement,
  video: HTMLVideoElement,
  lyrics: readonly TimedLyric[],
  signal: AbortSignal,
): HTMLElement {
  const viewport = document.createElement("div");
  viewport.className = viewportClass;
  viewport.tabIndex = 0;
  const list = document.createElement("div");
  list.className = listClass;
  const gaps = new Map<
    number,
    { start: number; end: number; counter: HTMLElement }
  >();
  let precedingEnd = 0;
  const rows = lyrics.map(({ text, start, end }, index) => {
    if (start - precedingEnd >= minimumInstrumentalGap) {
      const counter = document.createElement("div");
      counter.className = instrumentalClass;
      counter.hidden = true;
      gaps.set(index, { start: precedingEnd, end: start, counter });
      list.append(counter);
    }
    precedingEnd = Math.max(precedingEnd, end);
    const row = document.createElement("button");
    row.type = "button";
    const words = document.createElement("span");
    words.textContent = text;
    row.append(words);
    list.append(row);
    return row;
  });
  viewport.append(list);
  const footer = document.createElement("div");
  footer.className = sourceClass;
  function updateSource(): void {
    const source = panel
      .querySelector(`${shelfSelector} .footer`)
      ?.textContent?.trim();
    if (!source) {
      footer.remove();
      return;
    }
    if (footer.textContent !== source) footer.textContent = source;
    if (footer.parentElement !== viewport) viewport.append(footer);
  }
  updateSource();
  const sourceObserver = new MutationObserver(updateSource);
  sourceObserver.observe(panel, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["is-track-lyrics-page"],
  });
  panel.append(viewport);
  panel.scrollTop = 0;
  panel.setAttribute(activeLyricsPanel, "");

  let active: HTMLButtonElement | undefined;
  let currentCounter: HTMLElement | undefined;
  let focus: HTMLElement | undefined;
  let previousTime: number | undefined;
  const rowMotions = new Map<HTMLButtonElement, Animation>();

  function cancelStagger(): void {
    for (const animation of rowMotions.values()) animation.cancel();
    rowMotions.clear();
  }

  function staggerRows(index: number, distance: number): void {
    const offsets = new Map<
      HTMLButtonElement,
      { start: string; peak: number }
    >();
    for (const [row, animation] of rowMotions) {
      if (animation.playState !== "running") continue;
      const start = getComputedStyle(row).translate;
      if (start !== "none") offsets.set(row, { start, peak: 0 });
    }
    cancelStagger();
    const bottom = viewport.scrollTop + distance + viewport.clientHeight;
    const step = Math.min(distance * 0.1, 5);
    for (let next = index + 1; next < rows.length; next += 1) {
      const row = rows[next];
      if (!row || row.offsetTop >= bottom) break;
      offsets.set(row, {
        start: offsets.get(row)?.start ?? "0px 0px",
        peak: step * Math.min(next - index, 4),
      });
    }
    for (const [row, { start, peak }] of offsets) {
      const animation = row.animate(
        [
          { translate: start, offset: 0, easing: "ease-in-out" },
          { translate: `0px ${peak}px`, offset: 0.45, easing: "ease-in-out" },
          { translate: "0px 0px", offset: 1 },
        ],
        { duration: cueTransitionDuration },
      );
      rowMotions.set(row, animation);
    }
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const following = followScroll(
    viewport,
    () =>
      focus &&
      Math.max(
        0,
        focus.offsetTop + focus.offsetHeight / 2 - viewport.clientHeight * anchor,
      ),
    followDelay,
    reducedMotion,
    signal,
    cancelStagger,
  );

  function update(animate: boolean, force = false): void {
    const time = video.currentTime * 1000;
    const index = activeLyricIndex(lyrics, time);
    const line = lyrics[index];
    const row = rows[index];
    if (!line || !row || !Number.isFinite(time)) return;
    const elapsed = time - (previousTime ?? time);
    previousTime = time;
    if (video.seeking || elapsed < 0 || elapsed > cueContinuityLimit)
      cancelStagger();

    const gap = gaps.get(time < line.start ? index : index + 1);
    const inGap = gap && time >= gap.start && time < gap.end ? gap : undefined;
    const counter = inGap?.counter;
    if (currentCounter !== counter) {
      if (currentCounter) currentCounter.hidden = true;
      if (counter) counter.hidden = false;
      currentCounter = counter;
    }
    if (inGap) {
      const remaining = Math.ceil((inGap.end - time) / 1000);
      const minutes = Math.floor(remaining / 60);
      const seconds = String(remaining % 60).padStart(2, "0");
      const text = `♪ ${minutes}:${seconds}`;
      if (inGap.counter.textContent !== text) inGap.counter.textContent = text;
      if (!reducedMotion.matches)
        fillText(inGap.counter, time, inGap.start, inGap.end);
    }

    const nextActive = !inGap && time >= line.start ? row : undefined;
    const continuousTransition =
      active &&
      nextActive &&
      active !== nextActive &&
      focus === active &&
      !video.paused &&
      !video.seeking &&
      elapsed > 0 &&
      elapsed <= cueContinuityLimit;
    if (nextActive !== active) {
      active?.removeAttribute("aria-current");
      nextActive?.setAttribute("aria-current", "true");
      active = nextActive;
    }
    if (active && !reducedMotion.matches) {
      const end = Math.min(line.end, lyrics[index + 1]?.start ?? line.end);
      fillText(active, time, line.start, end);
    }
    const nextFocus = counter ?? row;
    if (nextFocus !== focus || force) {
      focus = nextFocus;
      if (viewport.clientHeight)
        following.follow(
          animate,
          continuousTransition
            ? (distance) => staggerRows(index, distance)
            : undefined,
        );
    }
  }

  function resize(): void {
    const leading = gaps.get(0)?.counter;
    const first = leading && !leading.hidden ? leading : rows[0];
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
      cancelStagger();
    },
    { once: true },
  );
  reducedMotion.addEventListener(
    "change",
    () => {
      if (reducedMotion.matches) {
        cancelStagger();
        update(false, true);
      }
    },
    { signal },
  );
  function lyricFor(target: EventTarget | null): TimedLyric | undefined {
    if (target instanceof HTMLButtonElement)
      return lyrics[rows.indexOf(target)];
  }
  function seek(lyric: TimedLyric): void {
    cancelStagger();
    previousTime = undefined;
    video.currentTime = lyric.start / 1000;
    update(true);
    following.resume();
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
  resize();
  watchPosition(video, () => update(true), () => !reducedMotion.matches, signal);
  return viewport;
}
