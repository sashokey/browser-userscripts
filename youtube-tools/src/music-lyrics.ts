import { navigation, read } from "./dom.ts";
import { fetchTimedLyrics, lyricsTimeout } from "./music-lyrics-data.ts";
import type { TimedLyric } from "./music-lyrics-data.ts";
import {
  activeLyricsPanel,
  followPlainLyrics,
  lyricsFillOff,
  lyricsFillToggle,
  pendingLyricsPanel,
  plainLyricsPanel,
  renderLyrics,
  styleLyrics,
} from "./music-lyrics-view.ts";

const pageSelector = "ytmusic-player-page";
const panelSelector = "ytmusic-tab-renderer#tab-renderer";
const buttonSelector = "tp-yt-paper-tab[role=tab]";
const lyricsPageType = "MUSIC_PAGE_TYPE_TRACK_LYRICS";
const volumeSelector = "ytmusic-player-bar .right-controls-buttons > yt-icon-button.volume";

type Result = { lyrics: readonly TimedLyric[] | undefined };
type Lookup = {
  id: string;
  controller: AbortController;
  available?: boolean;
  result?: Result;
  requestedTab?: HTMLElement;
};
type Presentation = {
  panel: HTMLElement;
  video: HTMLVideoElement;
  lookup: Lookup;
  controller: AbortController;
  viewport?: HTMLElement;
  updatePlain?: () => void;
};

function hasLyricsEndpoint(tab: unknown): boolean {
  return (
    read(
      tab,
      "endpoint",
      "browseEndpoint",
      "browseEndpointContextSupportedConfigs",
      "browseEndpointContextMusicConfig",
      "pageType",
    ) === lyricsPageType
  );
}

function tabControls(page: Element) {
  const buttons = page
    .querySelector("#side-panel > tp-yt-paper-tabs")
    ?.querySelectorAll<HTMLElement>(buttonSelector);
  const data = read(page, "tabs");
  if (!buttons || !Array.isArray(data) || buttons.length !== data.length)
    return;
  const tabs: unknown[] = data;
  const lyrics =
    buttons[
      tabs.findIndex((tab) => hasLyricsEndpoint(read(tab, "tabRenderer")))
    ];
  const queue =
    buttons[
      tabs.findIndex(
        (tab) =>
          read(tab, "tabRenderer", "content", "musicQueueRenderer") !==
          undefined,
      )
    ];
  if (lyrics && queue) return { lyrics, queue, buttons };
}

function selected(button: HTMLElement): boolean {
  return button.getAttribute("aria-selected") === "true";
}

function select(request: Lookup, button: HTMLElement): void {
  if (
    request.requestedTab === button ||
    selected(button) ||
    button.getAttribute("aria-disabled") === "true"
  )
    return;
  request.requestedTab = button;
  button.click();
}

export function musicLyrics(
  trackId: (video: HTMLVideoElement) => string | undefined,
  webVersion: () => string | undefined,
): (app: Element | null) => void {
  styleLyrics();

  let page: Element | null = null;
  let pageLifetime: AbortController | undefined;
  let lookup: Lookup | undefined;
  let presentation: Presentation | undefined;
  let cached: { id: string; lyrics: readonly TimedLyric[] } | undefined;
  let prefersLyrics: boolean | undefined;
  let fillEnabled = true;
  let fillToggle: HTMLButtonElement | undefined;
  let transition:
    { panel: HTMLElement; until: number; timer: number } | undefined;
  const observer = new MutationObserver(refresh);

  function syncFillToggle(app: Element | null): void {
    const volume = app?.querySelector(volumeSelector);
    if (!volume) {
      fillToggle?.remove();
      fillToggle = undefined;
      return;
    }
    if (!fillToggle) {
      const button = document.createElement("button");
      const label = document.documentElement.lang.startsWith("ru")
        ? "Заполнение слов"
        : "Lyric word fill";
      button.type = "button";
      button.title = label;
      button.setAttribute(lyricsFillToggle, "");
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(fillEnabled));
      button.addEventListener("click", () => {
        fillEnabled = !fillEnabled;
        button.setAttribute("aria-pressed", String(fillEnabled));
        presentation?.viewport?.toggleAttribute(lyricsFillOff, !fillEnabled);
      });
      fillToggle = button;
    }
    if (fillToggle.nextElementSibling !== volume) volume.before(fillToggle);
  }

  function stopLookup(): void {
    lookup?.controller.abort();
    lookup = undefined;
  }

  function stopPresentation(): void {
    if (!presentation) return;
    presentation.controller.abort();
    presentation.panel.removeAttribute(activeLyricsPanel);
    presentation.panel.removeAttribute(pendingLyricsPanel);
    presentation.panel.removeAttribute(plainLyricsPanel);
    presentation.viewport?.remove();
    presentation = undefined;
  }

  function finishTransition(): number {
    if (!transition) return lyricsTimeout;
    const { panel, until, timer } = transition;
    transition = undefined;
    window.clearTimeout(timer);
    panel.removeAttribute(pendingLyricsPanel);
    return Math.max(0, Math.floor(until - performance.now()));
  }

  function waitForTrack(panel: HTMLElement): void {
    if (transition?.panel === panel) return;
    finishTransition();
    panel.setAttribute(pendingLyricsPanel, "");
    transition = {
      panel,
      until: performance.now() + lyricsTimeout,
      timer: window.setTimeout(
        () => panel.removeAttribute(pendingLyricsPanel),
        lyricsTimeout,
      ),
    };
  }

  function startLookup(id: string, timeout: number): Lookup {
    stopLookup();
    const request: Lookup = { id, controller: new AbortController() };
    lookup = request;
    if (cached?.id === id) {
      request.available = true;
      request.result = { lyrics: cached.lyrics };
      return request;
    }
    const version = webVersion();
    if (!version || !timeout) {
      request.result = { lyrics: undefined };
      return request;
    }
    void fetchTimedLyrics(
      id,
      version,
      request.controller.signal,
      (available) => {
        if (lookup !== request) return;
        request.available = available;
        refresh();
      },
      timeout,
    ).then((lyrics) => {
      if (lookup !== request) return;
      request.result = { lyrics };
      if (lyrics) cached = { id, lyrics };
      refresh();
    });
    return request;
  }

  function show(
    panel: HTMLElement,
    video: HTMLVideoElement,
    request: Lookup,
  ): void {
    if (
      presentation?.panel !== panel ||
      presentation.video !== video ||
      presentation.lookup !== request
    ) {
      stopPresentation();
      presentation = {
        panel,
        video,
        lookup: request,
        controller: new AbortController(),
      };
    }
    const lyrics = request.result?.lyrics;
    panel.toggleAttribute(
      pendingLyricsPanel,
      !request.result && request.available !== false,
    );
    const plain = !!request.result && !lyrics && request.available !== false;
    panel.toggleAttribute(plainLyricsPanel, plain);
    if (plain) {
      presentation.updatePlain ??= followPlainLyrics(
        panel,
        video,
        presentation.controller.signal,
      );
      presentation.updatePlain();
    }
    if (lyrics && !presentation.viewport) {
      presentation.viewport = renderLyrics(
        panel,
        video,
        lyrics,
        presentation.controller.signal,
      );
      presentation.viewport.toggleAttribute(lyricsFillOff, !fillEnabled);
    }
    const viewport = presentation.viewport;
    if (viewport && viewport.parentElement !== panel) panel.append(viewport);
  }

  function rememberTab(event: Event): void {
    if (!page || !event.isTrusted || !(event.target instanceof Element)) return;
    if (
      event.type === "keydown" &&
      (!(event instanceof KeyboardEvent) ||
        (event.key !== "Enter" && event.key !== " "))
    )
      return;
    const button = event.target.closest(buttonSelector);
    if (!button || button.getAttribute("aria-disabled") === "true") return;
    const tabs = tabControls(page);
    if (tabs && [...tabs.buttons].some((header) => header === button)) {
      prefersLyrics = button === tabs.lyrics;
    }
  }

  function refresh(): void {
    const opened = page?.hasAttribute("player-page-open") ? page : null;
    const candidate = opened?.querySelector<HTMLElement>(panelSelector);
    const data = read(candidate, "data");
    const rendersLyrics = hasLyricsEndpoint(data);
    if (prefersLyrics === undefined && rendersLyrics) prefersLyrics = true;
    const video = opened?.querySelector<HTMLVideoElement>(
      "#movie_player video.html5-main-video",
    );
    const id = video && trackId(video);
    const tabs =
      opened && prefersLyrics && (!rendersLyrics || lookup?.available === false)
        ? tabControls(opened)
        : undefined;
    const lyricsSelected = tabs && selected(tabs.lyrics);
    const queueSelected = tabs && selected(tabs.queue);
    const panel =
      candidate && (rendersLyrics || (lyricsSelected && !data))
        ? candidate
        : undefined;
    if (!video || !id || !(panel || lyricsSelected || queueSelected)) {
      stopPresentation();
      stopLookup();
      if (panel && !id) waitForTrack(panel);
      else finishTransition();
      return;
    }
    const timeout = finishTransition();
    const request = lookup?.id === id ? lookup : startLookup(id, timeout);
    if (request.available === false && tabs && lyricsSelected) {
      stopPresentation();
      select(request, tabs.queue);
    } else if (panel) {
      show(panel, video, request);
    } else {
      stopPresentation();
      if (request.available === true && tabs && queueSelected)
        select(request, tabs.lyrics);
    }
  }

  return (app) => {
    syncFillToggle(app);
    if (page && app?.contains(page)) return;
    const next = app?.querySelector(pageSelector) ?? null;
    if (page === next) return;
    observer.disconnect();
    pageLifetime?.abort();
    stopPresentation();
    stopLookup();
    finishTransition();
    page = next;
    if (!page) return;
    pageLifetime = new AbortController();
    const signal = pageLifetime.signal;
    observer.observe(page, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-disabled",
        "aria-selected",
        "hidden",
        "is-track-lyrics-page",
        "player-page-open",
      ],
    });
    for (const event of ["click", "keydown"])
      page.addEventListener(event, rememberTab, { capture: true, signal });
    for (const event of ["loadstart", "loadedmetadata", "emptied"])
      page.addEventListener(event, refresh, { capture: true, signal });
    navigation(refresh, signal);
    refresh();
  };
}
