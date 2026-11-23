import { navigation, visible } from "./dom.ts";
import { fetchTimedLyrics } from "./music-lyrics-data.ts";
import type { TimedLyric } from "./music-lyrics-data.ts";
import {
  activeLyricsPanel,
  renderLyrics,
  styleLyrics,
} from "./music-lyrics-view.ts";

const pageSelector = "ytmusic-player-page";
const shelfSelector =
  "ytmusic-description-shelf-renderer[is-track-lyrics-page]";

type Target = {
  panel: HTMLElement;
  shelf: HTMLElement;
  video: HTMLVideoElement;
  id: string;
};
type Session = Target & { controller: AbortController; viewport?: HTMLElement };

function mount(session: Session, lyrics: readonly TimedLyric[]): void {
  const { panel, shelf, video, controller } = session;
  session.viewport = renderLyrics(
    panel,
    shelf,
    video,
    lyrics,
    controller.signal,
  );
}

function sameTarget(
  current: Session | undefined,
  target: Target | undefined,
): boolean {
  return (
    current?.id === target?.id &&
    current?.video === target?.video &&
    current?.shelf === target?.shelf &&
    current?.panel === target?.panel
  );
}

export function musicLyrics(
  trackId: (video: HTMLVideoElement) => string | undefined,
  webVersion: () => string | undefined,
): (app: Element | null) => void {
  styleLyrics(shelfSelector);

  let page: Element | null = null;
  let pageLifetime: AbortController | undefined;
  let session: Session | undefined;
  let cached: { id: string; lyrics: readonly TimedLyric[] } | undefined;
  const observer = new MutationObserver(refresh);
  const sectionObserver = new MutationObserver(refresh);
  let section: Element | null = null;

  function observeSection(next: Element | null): void {
    if (section === next) return;
    sectionObserver.disconnect();
    section = next;
    if (section)
      sectionObserver.observe(section, {
        attributes: true,
        attributeFilter: ["style"],
      });
  }

  function target(): Target | undefined {
    if (!page?.hasAttribute("player-page-open")) {
      observeSection(null);
      return;
    }
    const panel = page.querySelector<HTMLElement>(
      "ytmusic-tab-renderer#tab-renderer",
    );
    const shelf = panel?.querySelector<HTMLElement>(shelfSelector);
    observeSection(shelf?.closest("ytmusic-section-list-renderer") ?? null);
    const video = page.querySelector<HTMLVideoElement>(
      "#movie_player video.html5-main-video",
    );
    if (!panel || !shelf || !video || !visible(shelf)) return;
    const id = trackId(video);
    if (id) return { panel, shelf, video, id };
  }

  function stop(): void {
    if (!session) return;
    session.controller.abort();
    session.panel.removeAttribute(activeLyricsPanel);
    session.viewport?.remove();
    session = undefined;
  }

  function refresh(): void {
    const next = target();
    if (sameTarget(session, next)) return;
    stop();
    if (!next) return;
    const version = webVersion();
    if (!version) return;
    const pending = { ...next, controller: new AbortController() };
    session = pending;
    if (cached?.id === next.id) {
      mount(pending, cached.lyrics);
      return;
    }
    void fetchTimedLyrics(next.id, version, pending.controller.signal).then(
      (lyrics) => {
        if (!lyrics || session !== pending || !sameTarget(pending, target()))
          return;
        cached = { id: next.id, lyrics };
        mount(pending, lyrics);
      },
    );
  }

  return (app) => {
    if (page && app?.contains(page)) return;
    const next = app?.querySelector(pageSelector) ?? null;
    if (page === next) return;
    observer.disconnect();
    observeSection(null);
    pageLifetime?.abort();
    stop();
    page = next;
    if (!page) return;
    pageLifetime = new AbortController();
    observer.observe(page, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-selected",
        "hidden",
        "is-track-lyrics-page",
        "player-page-open",
      ],
    });
    for (const event of ["loadstart", "loadedmetadata", "emptied"])
      page.addEventListener(event, refresh, {
        capture: true,
        signal: pageLifetime.signal,
      });
    navigation(refresh, pageLifetime.signal);
    refresh();
  };
}
