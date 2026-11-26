import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

const player = "ytmusic-player-page";
const tab = "ytmusic-tab-renderer#tab-renderer";
const shelf = "ytmusic-description-shelf-renderer[is-track-lyrics-page]";
const section = "ytmusic-section-list-renderer";
const movie = "#movie_player video.html5-main-video";
const tabStrip = "#side-panel > tp-yt-paper-tabs";
const tabButton = "tp-yt-paper-tab[role=tab]";
const pending = "data-youtube-tools-lyrics-pending";
const plain = "data-youtube-tools-plain-lyrics";
const viewport = "youtube-tools-lyrics-viewport";
const firstTrack = "yntRHKkkWic";
const secondTrack = "J7p4bzqLvCw";

class Element extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  readonly elements = new Map<string, Element>();
  readonly style = { paddingBlockStart: "", paddingBlockEnd: "" };
  className = "";
  private text = "";
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
  }
  parentElement: Element | undefined;
  data: object | undefined;
  tabs: object[] | undefined;
  clickAction: (() => void) | undefined;
  currentTime = 0;
  scrollTop = 0;
  clientHeight = 200;
  offsetHeight = 24;
  offsetTop = 30;
  shown = true;

  querySelector(selector: string): Element | null {
    if (selector === `${shelf} .footer`)
      return this.elements.get(shelf)?.querySelector(".footer") ?? null;
    return (
      this.elements.get(selector) ??
      this.children.find((child) => `.${child.className}` === selector) ??
      null
    );
  }

  closest(selector: string): Element | null {
    return this.elements.get(selector) ?? null;
  }

  querySelectorAll(selector: string): Element[] {
    return selector === tabButton ? this.children : [];
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  click(): void {
    this.clickAction?.();
  }

  contains(child: Element): boolean {
    return [...this.elements.values()].includes(child);
  }

  getClientRects(): object[] {
    return this.shown ? [{}] : [];
  }

  append(...children: Element[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  toggleAttribute(name: string, force: boolean): void {
    if (force) this.setAttribute(name, "");
    else this.removeAttribute(name);
  }
}

const watch = (id: string, unavailable: boolean) => ({
  contents: {
    singleColumnMusicWatchNextResultsRenderer: {
      tabbedRenderer: {
        watchNextTabbedResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                endpoint: { browseEndpoint: { browseId: `MPLYt_${id}` } },
                ...(unavailable ? { unselectable: true } : {}),
              },
            },
          ],
        },
      },
    },
  },
});

const timed = (text: string) =>
  Response.json({
    contents: {
      elementRenderer: {
        newElement: {
          type: {
            componentType: {
              model: {
                timedLyricsModel: {
                  lyricsData: {
                    timedLyricsData: [
                      {
                        lyricLine: text,
                        cueRange: {
                          startTimeMilliseconds: 0,
                          endTimeMilliseconds: 1000,
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  });

async function fixture(context: TestContext, abortFetch = false) {
  const app = new Element();
  const page = new Element();
  const panel = new Element();
  const native = new Element();
  const wrapper = new Element();
  const video = new Element();
  const source = new Element();
  const strip = new Element();
  const upNext = new Element();
  const lyrics = new Element();
  const related = new Element();
  source.textContent = "Source: Example";
  const nativeTabs = {
    endpoint: {
      browseEndpoint: {
        browseEndpointContextSupportedConfigs: {
          browseEndpointContextMusicConfig: {
            pageType: "MUSIC_PAGE_TYPE_TRACK_LYRICS",
          },
        },
      },
    },
  };
  panel.data = nativeTabs;
  page.tabs = [
    { tabRenderer: { content: { musicQueueRenderer: {} } } },
    { tabRenderer: nativeTabs },
    { tabRenderer: {} },
  ];
  page.elements.set(tabStrip, strip);
  strip.append(upNext, lyrics, related);
  app.elements.set(player, page);
  page.setAttribute("player-page-open", "");
  page.elements.set(tab, panel);
  page.elements.set(movie, video);
  panel.elements.set(shelf, native);
  native.elements.set(section, wrapper);
  native.elements.set(".footer", source);

  const observers = new Map<object, Set<() => void>>();
  const window = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    matchMedia: () => Object.assign(new EventTarget(), { matches: true }),
  });
  const environment = {
    location: { hostname: "music.youtube.com" },
    document: Object.assign(new EventTarget(), {
      createElement: () => new Element(),
    }),
    window,
    unsafeWindow: window,
    Element,
    getComputedStyle: () => ({ visibility: "visible" }),
    HTMLButtonElement: Element,
    GM_addStyle: () => undefined,
    MutationObserver: class {
      constructor(privateCallback: () => void) {
        this.callback = () => {
          privateCallback();
        };
      }
      readonly callback: () => void;
      observe(target: object): void {
        const callbacks = observers.get(target) ?? new Set<() => void>();
        callbacks.add(this.callback);
        observers.set(target, callbacks);
      }
      disconnect(): void {
        for (const callbacks of observers.values())
          callbacks.delete(this.callback);
      }
    },
    ResizeObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
  };
  for (const [key, value] of Object.entries(environment))
    Reflect.set(globalThis, key, value);

  let id: string | undefined = firstTrack;
  let deferred: ((response: Response) => void) | undefined;
  let defer = true;
  let deferredTabs = false;
  let availability: "available" | "unavailable" | "unknown" = "available";
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) => {
      assert.equal(typeof init.body, "string");
      if (url.includes("/next?")) {
        return Promise.resolve(
          availability === "unknown"
            ? new Response(null, { status: 503 })
            : Response.json(
                watch(id ?? firstTrack, availability === "unavailable"),
              ),
        );
      }
      if (!defer) return Promise.resolve(timed("New track"));
      return new Promise<Response>((resolve, reject) => {
        deferred = resolve;
        if (abortFetch) {
          const signal = init.signal;
          signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Lookup aborted", "AbortError"));
            },
            { once: true },
          );
        }
      });
    },
  );
  const { musicLyrics } = await import("../src/music-lyrics.ts");
  const sync = musicLyrics(
    () => id,
    () => "1.20261122.17.00",
  );
  const notify = (target: Element): void => {
    for (const callback of [...(observers.get(target) ?? [])]) callback();
  };
  for (const button of strip.children) {
    button.elements.set(tabButton, button);
    button.clickAction = () => {
      const selectTab = () => {
        for (const header of strip.children) {
          header.setAttribute("aria-selected", String(header === button));
        }
        panel.data = button === lyrics ? nativeTabs : {};
      };
      if (deferredTabs) {
        queueMicrotask(() => {
          selectTab();
          notify(page);
        });
      } else selectTab();
    };
  }
  lyrics.click();
  context.after(() => {
    sync(null);
    for (const key of Object.keys(environment))
      Reflect.deleteProperty(globalThis, key);
  });
  return {
    page,
    panel,
    native,
    wrapper,
    start: () => {
      Reflect.apply(sync, null, [app]);
    },
    close: () => sync(null),
    rerender: () => notify(page),
    nativeUpdate: () => {
      notify(wrapper);
      notify(page);
    },
    replaceNative: () => {
      const replacement = new Element();
      const footer = new Element();
      footer.textContent = "Replacement source";
      replacement.elements.set(".footer", footer);
      panel.elements.set(shelf, replacement);
      notify(panel);
      notify(page);
    },
    removeNative: () => panel.elements.delete(shelf),
    view: () => panel.querySelector(`.${viewport}`),
    resolve: (response: Response) => {
      assert.ok(deferred);
      deferred(response);
    },
    changeTrack: (
      next = secondTrack,
      state: typeof availability = "available",
    ) => {
      id = next;
      defer = false;
      availability = state;
      notify(page);
    },
    setLyricsTabDisabled: (disabled: boolean) => {
      lyrics.setAttribute("aria-disabled", String(disabled));
      notify(page);
    },
    unsetTrack: () => {
      id = undefined;
      notify(page);
    },
    unsetPanelData: () => {
      panel.data = undefined;
      notify(page);
    },
    nativeQueue: () => {
      upNext.click();
      notify(page);
    },
    deferTabChanges: () => {
      deferredTabs = true;
    },
    userTab: (kind: "lyrics" | "queue" | "related") => {
      const button = { lyrics, queue: upNext, related }[kind];
      const event = new Event("click");
      Object.defineProperties(event, {
        target: { value: button },
        isTrusted: { value: true },
      });
      page.dispatchEvent(event);
      button.click();
      notify(page);
    },
    selected: () => {
      if (lyrics.getAttribute("aria-selected") === "true") return "lyrics";
      if (upNext.getAttribute("aria-selected") === "true") return "queue";
      return "related";
    },
    calls: () => fetch.mock.callCount(),
  };
}

void test("covers the native lyrics while timings are pending and reveals the synced view directly", async (context) => {
  const scene = await fixture(context);
  scene.start();
  assert.equal(scene.panel.hasAttribute(pending), true);
  assert.equal(scene.view(), null);
  await nextTurn();
  scene.resolve(timed("Synced"));
  await nextTurn();
  assert.equal(scene.panel.hasAttribute(pending), false);
  assert.equal(scene.view()?.children[0]?.children[0]?.textContent, "Synced");
});

void test("keeps the same synced viewport and scroll when YouTube hides and restores the native shelf", async (context) => {
  const scene = await fixture(context);
  scene.start();
  await nextTurn();
  scene.resolve(timed("Same track"));
  await nextTurn();
  const view = scene.view();
  assert.ok(view);
  view.scrollTop = 38;
  scene.native.shown = false;
  scene.nativeUpdate();
  assert.equal(scene.view(), view);
  scene.native.shown = true;
  scene.nativeUpdate();
  assert.equal(scene.view()?.scrollTop, 38);
  assert.equal(scene.calls(), 2);
});

void test("looks up timings before the native shelf arrives", async (context) => {
  const scene = await fixture(context);
  scene.removeNative();
  scene.start();
  await nextTurn();
  assert.equal(scene.calls(), 2);
  scene.resolve(timed("Ready without native shelf"));
  await nextTurn();
  assert.equal(
    scene.view()?.children[0]?.children[0]?.textContent,
    "Ready without native shelf",
  );
});

void test("updates the footer when the native shelf is replaced and restores a detached viewport", async (context) => {
  const scene = await fixture(context);
  scene.start();
  await nextTurn();
  scene.resolve(timed("Persistent view"));
  await nextTurn();
  const view = scene.view();
  assert.ok(view);
  scene.replaceNative();
  assert.equal(view.children.at(-1)?.textContent, "Replacement source");
  view.remove();
  scene.rerender();
  assert.ok(scene.view() === view);
  assert.equal(scene.calls(), 2);
});

void test("reveals native lyrics after a failed lookup without a second request on native refresh", async (context) => {
  const scene = await fixture(context);
  scene.start();
  assert.equal(scene.panel.hasAttribute(pending), true);
  await nextTurn();
  scene.resolve(new Response(null, { status: 503 }));
  await nextTurn();
  scene.native.shown = false;
  scene.nativeUpdate();
  scene.native.shown = true;
  scene.nativeUpdate();
  assert.equal(scene.panel.hasAttribute(pending), false);
  assert.equal(scene.view(), null);
  assert.equal(scene.calls(), 2);
});

void test("ignores a superseded result even when the native panel is recycled for the new track", async (context) => {
  const scene = await fixture(context);
  scene.start();
  await nextTurn();
  scene.changeTrack();
  await nextTurn();
  const view = scene.view();
  assert.equal(view?.children[0]?.children[0]?.textContent, "New track");
  scene.resolve(timed("Old track"));
  await nextTurn();
  assert.equal(scene.view(), view);
  assert.equal(
    scene.view()?.children[0]?.children[0]?.textContent,
    "New track",
  );
});

void test("clears pending state on teardown and cannot mount a late reply", async (context) => {
  const scene = await fixture(context);
  scene.start();
  assert.equal(scene.panel.hasAttribute(pending), true);
  await nextTurn();
  scene.close();
  scene.resolve(timed("Closed"));
  await nextTurn();
  assert.equal(scene.panel.hasAttribute(pending), false);
  assert.equal(scene.view(), null);
});

void test("styles only the available plain lyrics and clears the style when the user leaves", async (context) => {
  const scene = await fixture(context);
  scene.start();
  assert.equal(scene.panel.hasAttribute(plain), false);
  await nextTurn();
  scene.resolve(Response.json({ contents: { sectionListRenderer: {} } }));
  await nextTurn();
  assert.equal(scene.panel.hasAttribute(plain), true);
  assert.equal(scene.view(), null);
  scene.userTab("queue");
  assert.equal(scene.panel.hasAttribute(plain), false);
});

void test("releases the loading state after the eight-second lookup deadline", async (context) => {
  const deadline = new AbortController();
  const timeout = context.mock.method(
    AbortSignal,
    "timeout",
    (milliseconds: number) => {
      assert.equal(milliseconds, 8000);
      return deadline.signal;
    },
  );
  const scene = await fixture(context, true);
  scene.start();
  await nextTurn();
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(scene.panel.hasAttribute(pending), true);
  deadline.abort();
  await nextTurn();
  assert.equal(scene.panel.hasAttribute(pending), false);
  assert.equal(scene.panel.hasAttribute(plain), true);
  assert.equal(scene.view(), null);
});

void test("moves to the queue on explicit unavailability and restores the selected lyrics on the next track", async (context) => {
  const scene = await fixture(context);
  scene.start();
  scene.userTab("lyrics");
  await nextTurn();
  scene.resolve(timed("First track"));
  await nextTurn();
  scene.changeTrack(secondTrack, "unavailable");
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  assert.equal(scene.view(), null);
  assert.equal(scene.panel.hasAttribute(plain), false);
  assert.equal(scene.calls(), 3);
  scene.setLyricsTabDisabled(true);
  scene.changeTrack("Az73xtKbOIA");
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  scene.setLyricsTabDisabled(false);
  assert.equal(scene.selected(), "lyrics");
  scene.rerender();
  assert.equal(
    scene.view()?.children[0]?.children[0]?.textContent,
    "New track",
  );
  assert.equal(scene.calls(), 5);
});

void test("honors a manual tab choice made while in the automatic queue fallback", async (context) => {
  const scene = await fixture(context);
  scene.start();
  scene.userTab("lyrics");
  await nextTurn();
  scene.resolve(timed("First track"));
  await nextTurn();
  scene.changeTrack(secondTrack, "unavailable");
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  scene.userTab("queue");
  scene.changeTrack("Az73xtKbOIA");
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  assert.equal(scene.calls(), 3);
});

void test("keeps the chosen tab when availability is unknown and cancels restoration on a manual related-tab choice", async (context) => {
  const scene = await fixture(context);
  scene.start();
  scene.userTab("lyrics");
  await nextTurn();
  scene.resolve(timed("First track"));
  await nextTurn();
  scene.changeTrack(secondTrack, "unknown");
  await nextTurn();
  assert.equal(scene.selected(), "lyrics");
  scene.changeTrack("Az73xtKbOIA", "unavailable");
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  scene.userTab("related");
  scene.changeTrack("aAJfUFZgh2Y");
  await nextTurn();
  assert.equal(scene.selected(), "related");
  assert.equal(scene.calls(), 4);
});

void test("keeps native text covered until the URL and player settle on the new track", async (context) => {
  const scene = await fixture(context);
  scene.start();
  await nextTurn();
  scene.resolve(timed("Previous track"));
  await nextTurn();
  scene.unsetTrack();
  assert.equal(scene.panel.hasAttribute(pending), true);
  assert.equal(scene.view(), null);
  scene.changeTrack();
  await nextTurn();
  assert.equal(scene.panel.hasAttribute(pending), false);
  assert.equal(
    scene.view()?.children[0]?.children[0]?.textContent,
    "New track",
  );
});

void test("retains the synced view during a temporary native lyrics metadata reset", async (context) => {
  const scene = await fixture(context);
  scene.start();
  await nextTurn();
  scene.resolve(timed("Current track"));
  await nextTurn();
  const view = scene.view();
  assert.ok(view);
  view.scrollTop = 30;
  scene.unsetPanelData();
  assert.ok(scene.view() === view);
  assert.equal(scene.view()?.scrollTop, 30);
  assert.equal(scene.calls(), 2);
});

void test("restores the preferred lyrics after the player automatically resets to the queue", async (context) => {
  const scene = await fixture(context);
  scene.start();
  scene.userTab("lyrics");
  await nextTurn();
  scene.resolve(timed("First track"));
  await nextTurn();
  scene.changeTrack(secondTrack, "unavailable");
  scene.nativeQueue();
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  scene.changeTrack("Az73xtKbOIA");
  await nextTurn();
  assert.equal(scene.selected(), "lyrics");
  assert.equal(
    scene.view()?.children[0]?.children[0]?.textContent,
    "New track",
  );
});

void test("preserves the lyrics choice when the native tab selection updates asynchronously", async (context) => {
  const scene = await fixture(context);
  scene.start();
  scene.userTab("lyrics");
  await nextTurn();
  scene.resolve(timed("First track"));
  await nextTurn();
  scene.deferTabChanges();
  scene.changeTrack(secondTrack, "unavailable");
  await nextTurn();
  assert.equal(scene.selected(), "queue");
  scene.changeTrack("Az73xtKbOIA");
  await nextTurn();
  assert.equal(scene.selected(), "lyrics");
  assert.equal(
    scene.view()?.children[0]?.children[0]?.textContent,
    "New track",
  );
});
