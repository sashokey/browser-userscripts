import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { renderLyrics } from "../src/music-lyrics-view.ts";

class Element extends EventTarget {
  readonly children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = { paddingBlockStart: "0px", paddingBlockEnd: "0px" };
  textContent = "";
  className = "";
  parent: Element | undefined;
  scrollTop = 0;
  clientHeight = 200;
  offsetHeight = 24;
  currentTime = 0;
  paused = true;

  constructor(tag: string) {
    super();
    this.tag = tag;
  }

  readonly tag: string;

  get offsetTop(): number {
    if (!this.parent) return 0;
    return (
      parseFloat(this.parent.style.paddingBlockStart) +
      this.parent.children.indexOf(this) * 44
    );
  }

  append(...children: Element[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  get parentElement(): Element | undefined {
    return this.parent;
  }

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parent = undefined;
  }

  querySelector(selector: string): Element | undefined {
    return this.children.find((child) => `.${child.className}` === selector);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

const lyrics = [
  { text: "First", start: 0 },
  { text: "Second", start: 1250 },
  { text: "Last", start: 5000 },
];

void test("the source follows the lyrics and selecting a row seeks without resuming playback", (context) => {
  const { panel, shelf, video, signal } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, shelf, video, lyrics, signal]);
  const view = panel.children[0];
  const list = view?.children[0];
  const row = list?.children[1];
  assert.ok(view && list && row);
  assert.deepEqual(
    view.children.map((element) => element.tag),
    ["div", "div"],
  );
  assert.equal(view.children.at(-1)?.textContent, "Source: Example");
  assert.equal(row.tag, "button");
  click(list, row);
  assert.equal(video.currentTime, 1.25);
  assert.equal(video.paused, true);
  assert.equal(row.attributes.get("aria-current"), "true");
  assert.equal(view.scrollTop, 44);
});

void test("the source footer follows late changes to the native attribution", (context) => {
  const { panel, shelf, video, signal, source, notifySource } =
    fixture(context);
  source.textContent = "";
  Reflect.apply(renderLyrics, null, [panel, shelf, video, lyrics, signal]);
  const view = panel.children[0];
  assert.ok(view);
  assert.equal(view.children.length, 1);
  source.textContent = "Source: Late attribution";
  notifySource();
  assert.equal(view.children.length, 2);
  assert.equal(view.children.at(-1)?.textContent, "Source: Late attribution");
  source.textContent = "Source: Updated attribution";
  notifySource();
  assert.equal(view.children.length, 2);
  assert.equal(
    view.children.at(-1)?.textContent,
    "Source: Updated attribution",
  );
  source.textContent = "";
  notifySource();
  assert.equal(view.children.length, 1);
});

void test("keyboard activation consumes the player shortcut and seeks to the focused line", (context) => {
  const { panel, shelf, video, signal, browserWindow } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, shelf, video, lyrics, signal]);
  const focused = panel.children[0]?.children[0]?.children[1];
  assert.ok(focused);
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    target: { value: focused },
    key: { value: " " },
  });
  browserWindow.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(video.currentTime, 1.25);
  assert.equal(video.paused, true);
});

void test("manual scrolling postpones following until two seconds after the last activity", (context) => {
  const { panel, shelf, video, signal } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, shelf, video, lyrics, signal]);
  const view = panel.children[0];
  const last = view?.children[0]?.children[2];
  assert.ok(view && last);
  view.dispatchEvent(new Event("wheel"));
  view.scrollTop = 24;
  view.dispatchEvent(new Event("scroll"));
  video.currentTime = 5;
  video.dispatchEvent(new Event("timeupdate"));
  assert.equal(last.attributes.get("aria-current"), "true");
  assert.equal(view.scrollTop, 24);
  context.mock.timers.tick(1500);
  view.scrollTop = 36;
  view.dispatchEvent(new Event("scroll"));
  context.mock.timers.tick(1999);
  assert.equal(view.scrollTop, 36);
  context.mock.timers.tick(1);
  assert.equal(view.scrollTop, 88);
});

void test("closing the lyrics cancels the pending return to the active row", (context) => {
  const { panel, shelf, video, signal, end } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, shelf, video, lyrics, signal]);
  const view = panel.children[0];
  assert.ok(view);
  view.scrollTop = 26;
  view.dispatchEvent(new Event("scroll"));
  end();
  context.mock.timers.tick(2000);
  assert.equal(view.scrollTop, 26);
});

function click(list: Element, row: Element): void {
  const event = new Event("click");
  Object.defineProperty(event, "target", { value: row });
  list.dispatchEvent(event);
}

function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const panel = new Element("ytmusic-tab-renderer");
  const shelf = new Element("ytmusic-description-shelf-renderer");
  const source = new Element("yt-formatted-string");
  source.className = "footer";
  source.textContent = "Source: Example";
  shelf.append(source);
  const video = new Element("video");
  let sourceChange: (() => void) | undefined;
  const browserWindow = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: true }),
  });
  const environment = {
    document: { createElement: (tag: string) => new Element(tag) },
    window: browserWindow,
    HTMLButtonElement: Element,
    MutationObserver: class {
      constructor(callback: () => void) {
        sourceChange = callback;
      }
      observe(): void {}
      disconnect(): void {
        sourceChange = undefined;
      }
    },
    ResizeObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
  };
  for (const [key, value] of Object.entries(environment))
    Reflect.set(globalThis, key, value);
  context.after(() => {
    controller.abort();
    for (const key of Object.keys(environment))
      Reflect.deleteProperty(globalThis, key);
  });
  return {
    panel,
    shelf,
    video,
    browserWindow,
    source,
    notifySource: () => {
      sourceChange?.();
    },
    signal: controller.signal,
    end: () => {
      controller.abort();
    },
  };
}
