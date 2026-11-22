// ==UserScript==
// @name         Skip Twitch Muted Segments
// @namespace    local.skip-twitch-muted-segments
// @version      1.0.6
// @description  Violentmonkey userscript that automatically skips red muted segments in Twitch video recordings.
// @match        https://www.twitch.tv/*
// @noframes
// @run-at       document-start
// @inject-into  page
// @grant        none
// @homepageURL  https://github.com/sashokey/browser-userscripts
// @updateURL    https://raw.githubusercontent.com/sashokey/browser-userscripts/master/skip-twitch-muted-segments/skip-twitch-muted-segments.user.js
// @downloadURL  https://raw.githubusercontent.com/sashokey/browser-userscripts/master/skip-twitch-muted-segments/skip-twitch-muted-segments.user.js
// ==/UserScript==

(() => {
  'use strict';

  const initialized = Symbol.for('local.skip-twitch-muted-segments');
  const state: unknown = Reflect.get(window, initialized);
  if (state) return;
  Reflect.set(window, initialized, true);

  const playerSelector = '[data-a-target="video-player"]';
  const controlsSelector = '[data-a-target="player-controls"]';
  const seekbarSelector = '[data-a-target="player-seekbar"]';
  const durationSelector = '[data-a-target="player-seekbar-duration"]';
  const segmentSelector = '[data-test-selector="seekbar-segment__segment"]';
  interface Media {
    video: HTMLVideoElement;
    source: string;
    sourceObject: HTMLVideoElement['srcObject'];
    load: number;
    duration: number;
  }
  interface Scale {
    seekbar: Element;
    recording: string | undefined;
    duration: number;
    signature: string;
    markers: Set<HTMLElement>;
    merged: [number, number][];
  }
  interface Recording { id: string; media: Media; scale: Scale }
  interface Playback {
    observed?: Recording;
    boundary?: Recording;
    trusted?: Recording;
  }
  const timelines = new WeakMap<Element, Playback>();
  interface Branches {
    fiber: object;
    alternate: object | undefined;
    root: object | undefined;
    alternateRoot: object | undefined;
  }
  const fibers = new WeakMap<Element, Branches>();
  const videoLoads = new WeakMap<HTMLVideoElement, number>();
  const lastSeek = new WeakMap<HTMLVideoElement, { time: number; target: number; awaiting: boolean }>();
  const getVideoId = () => location.pathname.match(/^\/(?:videos\/|[^/]+\/video\/)(\d+)(?:\/|$)/)?.[1] || '';

  function object(value: unknown): object | undefined {
    if (value !== null && typeof value === 'object') return value;
  }

  function field(value: unknown, key: string): unknown {
    const owner = object(value);
    if (owner) return Reflect.get(owner, key);
  }

  function fiberRoot(fiber: object): object | undefined {
    for (let count = 0; count < 512; count++) {
      const parent = object(field(fiber, 'return'));
      if (!parent) return fiber;
      fiber = parent;
    }
  }

  function recordingId(seekbar: Element): string | undefined {
    try {
      const key = Object.keys(seekbar).find(name => name.startsWith('__reactFiber$'));
      const fiber = key && object(field(seekbar, key));
      if (!fiber) return;
      const alternate = object(field(fiber, 'alternate'));
      let branches = fibers.get(seekbar);
      if (branches?.fiber !== fiber || branches.alternate !== alternate) {
        branches = { fiber, alternate, root: fiberRoot(fiber), alternateRoot: alternate && fiberRoot(alternate) };
        fibers.set(seekbar, branches);
      }
      let active = branches.root && field(field(branches.root, 'stateNode'), 'current') === branches.root
        ? fiber
        : branches.alternateRoot && field(field(branches.alternateRoot, 'stateNode'), 'current') === branches.alternateRoot
          ? alternate : undefined;
      for (let depth = 0; active && depth < 48; depth++, active = object(field(active, 'return'))) {
        const id = field(field(active, 'memoizedProps'), 'vodID');
        if (typeof id === 'string' && /^\d+$/.test(id)) return id;
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id);
      }
    } catch {}
  }

  function percentage(value: string): number {
    return /^\d+(?:\.\d+)?%$/.test(value) ? Number.parseFloat(value) / 100 : NaN;
  }

  function visible(element: Element): boolean {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible';
  }

  function opaqueWithin(element: Element, boundary: Element): boolean {
    for (let node: Element | null = element; node && node !== boundary; node = node.parentElement) {
      if (getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  }

  function preferred<T extends Element>(candidates: T[], boundary: Element): T | undefined {
    if (candidates.length < 2) return candidates[0];
    const opaque = candidates.filter(element => opaqueWithin(element, boundary));
    return opaque.length === 1 ? opaque[0] : undefined;
  }

  function isMutedSegment(segment: HTMLElement, seekbar: Element): boolean {
    const style = getComputedStyle(segment);
    const color = style.backgroundColor;
    const values = color.match(/[\d.]+/g)?.map(Number);
    if (!/^rgba?\(/.test(color) || !values || values.length < 3 || values.length > 4) return false;
    const [red, green, blue, alpha = 1] = values;
    if (red === undefined || green === undefined || blue === undefined || ![red, green, blue, alpha].every(Number.isFinite)) return false;
    if (!(alpha > 0 && red >= 150 && red > green * 1.8 && red > blue * 1.8)) return false;
    if (style.visibility !== 'visible' || style.opacity === '0' || !segment.getClientRects().length) return false;
    return !segment.parentElement || opaqueWithin(segment.parentElement, seekbar);
  }

  function readSegments(seekbar: Element, duration: number) {
    const ranges: [number, number][] = [];
    const markers = new Set<HTMLElement>();
    for (const segment of seekbar.querySelectorAll(segmentSelector)) {
      if (!(segment instanceof HTMLElement) || !isMutedSegment(segment, seekbar)) continue;
      const start = percentage(segment.style.insetInlineStart || segment.style.left);
      const width = percentage(segment.style.width);
      if (!Number.isFinite(start) || !Number.isFinite(width) || start >= 1 || width <= 0 || width > 1 || start + width > 1.000001) continue;
      markers.add(segment);
      ranges.push([start, Math.min(1, start + width)]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const signature = ranges.join(';');
    const merged: [number, number][] = [];
    const tolerance = Math.max(0.05, duration * 0.000001);
    for (const [from, to] of ranges) {
      const start = from * duration, end = to * duration;
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1] + tolerance) {
        previous[1] = Math.max(previous[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return { merged, signature, markers };
  }

  function readScale(player: Element, mediaDuration: number): Scale | undefined {
    if (!Number.isFinite(mediaDuration)) return;
    const compatible = new Map<Element, number>();
    for (const bar of player.querySelectorAll(seekbarSelector)) {
      if (!visible(bar)) continue;
      const controls = bar.closest(controlsSelector) ?? player;
      const duration = [...controls.querySelectorAll(durationSelector)]
        .filter(visible)
        .map(element => Number(element.getAttribute('data-a-value')))
        .filter(value => value > 0 && Math.abs(mediaDuration - value) <= 1)
        .sort((a, b) => Math.abs(mediaDuration - a) - Math.abs(mediaDuration - b))[0];
      if (duration !== undefined) compatible.set(bar, duration);
    }
    const seekbar = preferred([...compatible.keys()], player);
    const duration = seekbar && compatible.get(seekbar);
    if (seekbar && duration !== undefined)
      return { seekbar, duration, recording: recordingId(seekbar), ...readSegments(seekbar, duration) };
  }

  function sameSource(a: Media, b: Media): boolean {
    return a.video === b.video && a.source === b.source && a.sourceObject === b.sourceObject;
  }

  function sameMedia(a: Media, b: Media): boolean {
    return sameSource(a, b) && a.load === b.load;
  }

  function sameScale(a: Scale, b: Scale | undefined): boolean {
    return !!b && (!a.recording || !b.recording || a.recording === b.recording)
      && a.seekbar === b.seekbar && a.duration === b.duration && a.signature === b.signature
      && a.markers.size === b.markers.size && [...a.markers].every(marker => b.markers.has(marker));
  }

  function skipMuted(video: unknown, event?: string): void {
    const route = getVideoId();
    if (!route) return;
    if (!(video instanceof HTMLVideoElement) || !video.isConnected || video.readyState < 1) return;
    if (event === 'seeking') {
      const last = lastSeek.get(video);
      if (last?.awaiting) last.awaiting = false;
      else lastSeek.delete(video);
      return;
    }
    const loaded = event === 'loadedmetadata';
    const load = (videoLoads.get(video) ?? 0) + Number(loaded);
    if (loaded) videoLoads.set(video, load);
    const player = video.closest(playerSelector);
    if (!player) return;
    if (preferred([...player.querySelectorAll('video')].filter(visible), player) !== video) return;
    const media = { video, source: video.currentSrc, sourceObject: video.srcObject, load, duration: video.duration };
    const scale = readScale(player, media.duration);
    if (!scale) return;
    const id = scale.recording ?? route;
    const state = timelines.get(player) ?? {};
    timelines.set(player, state);
    const trusted = state.trusted;
    if (scale.recording) {
      const playerId = recordingId(player);
      if (playerId && playerId !== scale.recording) return;
      if (id !== route && (!trusted || trusted.id === id)) return;
      if (trusted?.id === id && !sameSource(media, trusted.media) && sameScale(scale, trusted.scale)) return;
    }
    if (state.observed && state.observed.id !== id) state.boundary = state.observed;
    const current = { id, media, scale };
    state.observed = current;
    if (state.boundary) {
      const restored = trusted?.id === id && sameMedia(media, trusted.media) && sameScale(scale, trusted.scale);
      if (!restored && (sameMedia(media, state.boundary.media) || sameScale(scale, state.boundary.scale))) return;
      delete state.boundary;
    }
    state.trusted = current;
    if (id !== route) return;
    if (video.paused || video.seeking || video.ended) return;
    const time = video.currentTime;
    if (!Number.isFinite(time)) return;
    const range = scale.merged.find(([start, end]) => time >= start && time < end);
    if (!range) return;
    const target = Math.min(video.duration, range[1] + 0.1);
    if (target <= time) return;

    const now = performance.now();
    const last = lastSeek.get(video);
    if (last?.target === target && now - last.time < 1000) return;
    lastSeek.set(video, { time: now, target, awaiting: true });
    try {
      video.currentTime = target;
    } catch (error) {
      console.warn('Skip Twitch Muted Segments: could not seek', error);
    }
  }

  function scanPlayers(): void {
    for (const video of document.querySelectorAll(`${playerSelector} video`)) skipMuted(video);
  }

  for (const event of ['timeupdate', 'playing', 'seeking', 'seeked', 'loadedmetadata', 'durationchange']) {
    document.addEventListener(event, ({ target, type }) => skipMuted(target, type), true);
  }
  window.addEventListener('popstate', scanPlayers);
  window.addEventListener('pageshow', scanPlayers);
  scanPlayers();
})();


