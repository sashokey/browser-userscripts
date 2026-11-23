import { navigation, visible } from "./dom.ts";
import { activeLyricIndex, fetchTimedLyrics } from "./music-lyrics-data.ts";
import type { TimedLyric } from "./music-lyrics-data.ts";

const pageSelector = "ytmusic-player-page";
const shelfSelector =
  "ytmusic-description-shelf-renderer[is-track-lyrics-page]";
const activePanel = "data-youtube-tools-synced-lyrics";
const viewportClass = "youtube-tools-lyrics-viewport";
const listClass = "youtube-tools-lyrics-lines";

type Target = {
  panel: HTMLElement;
  shelf: HTMLElement;
  video: HTMLVideoElement;
  id: string;
};
type Session = Target & { controller: AbortController; viewport?: HTMLElement };

function renderLyrics(session: Session, lyrics: readonly TimedLyric[]): void {
  const { panel, video, controller } = session;
  const viewport = document.createElement("div");
  const list = document.createElement("div");
  viewport.className = viewportClass;
  list.className = listClass;
  const rows = lyrics.map(({ text }) => {
    const row = document.createElement("div");
    row.textContent = text;
    return row;
  });
  list.append(...rows);
  viewport.append(list);
  panel.append(viewport);
  panel.scrollTop = 0;
  panel.setAttribute(activePanel, "");
  session.viewport = viewport;

  let active: HTMLElement | undefined;
  let offset: number | undefined;
  function update(animate: boolean): void {
    const row = rows[activeLyricIndex(lyrics, video.currentTime * 1000)];
    if (!row || !viewport.clientHeight) return;
    const changed = row !== active;
    if (animate && !changed) return;
    if (changed) {
      active?.removeAttribute("aria-current");
      row.setAttribute("aria-current", "true");
      active = row;
    }
    const next =
      viewport.clientHeight * 0.42 - row.offsetTop - row.offsetHeight / 2;
    if (next === offset) return;
    list.toggleAttribute(
      "data-moving",
      animate && changed && offset !== undefined,
    );
    list.style.transform = `translateY(${next}px)`;
    offset = next;
  }

  const resize = new ResizeObserver(() => {
    update(false);
  });
  resize.observe(viewport);
  resize.observe(list);
  controller.signal.addEventListener(
    "abort",
    () => {
      resize.disconnect();
    },
    { once: true },
  );
  for (const event of ["timeupdate", "seeked"])
    video.addEventListener(
      event,
      () => {
        update(true);
      },
      { signal: controller.signal },
    );
  update(false);
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
  GM_addStyle(`
    ytmusic-tab-renderer[${activePanel}] { position:relative; overflow:hidden!important }
    [${activePanel}] ${shelfSelector} { position:absolute; inset:auto 0 0; z-index:1 }
    [${activePanel}] ${shelfSelector} :is(.description,#description-button) { display:none!important }
    .${viewportClass} { position:absolute; inset:0; overflow:hidden }
    .${listClass} {
      position:absolute; inset:0 0 auto; display:grid; gap:clamp(12px,2vh,24px);
      padding-inline:clamp(16px,3vw,36px); color:#fff;
      font-size:clamp(23px,3.5vw,32px); font-weight:700; line-height:1.18;
      overflow-wrap:anywhere; white-space:pre-line
    }
    .${listClass}[data-moving] { transition:transform 360ms ease-in-out }
    .${listClass} > div { opacity:.45; transition:opacity 240ms ease-out }
    .${listClass} > [aria-current=true] { opacity:1 }
    @media (prefers-reduced-motion: reduce) {
      .${listClass}[data-moving], .${listClass} > div { transition:none }
    }
  `);

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
    session.panel.removeAttribute(activePanel);
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
      renderLyrics(pending, cached.lyrics);
      return;
    }
    void fetchTimedLyrics(next.id, version, pending.controller.signal).then(
      (lyrics) => {
        if (!lyrics || session !== pending || !sameTarget(pending, target()))
          return;
        cached = { id: next.id, lyrics };
        renderLyrics(pending, lyrics);
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
