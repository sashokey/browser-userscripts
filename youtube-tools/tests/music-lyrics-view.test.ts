import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { renderLyrics } from "../src/music-lyrics-view.ts";

class RowAnimation {
  playState: AnimationPlayState = "running";
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;

  constructor(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    this.keyframes = keyframes;
    this.options = options;
  }

  cancel(): void {
    this.playState = "idle";
  }
}

class Element extends EventTarget {
  readonly children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly animations: RowAnimation[] = [];
  readonly style = {
    paddingBlockStart: "0px",
    paddingBlockEnd: "0px",
    setProperty: (name: string, value: string) => {
      this.properties.set(name, value);
    },
    getPropertyValue: (name: string) => this.properties.get(name) ?? "",
  };
  private readonly properties = new Map<string, string>();
  textContent = "";
  className = "";
  parent: Element | undefined;
  nativeShelf: Element | undefined;
  scrollTop = 0;
  scrollHeight = 200;
  clientHeight = 200;
  offsetHeight = 24;
  currentTime = 0;
  duration = 0;
  readyState = 4;
  ended = false;
  paused = true;
  seeking = false;
  hidden = false;

  constructor(tag: string) {
    super();
    this.tag = tag;
  }

  readonly tag: string;

  animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): RowAnimation {
    const animation = new RowAnimation(keyframes, options);
    this.animations.push(animation);
    return animation;
  }

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
    if (selector.endsWith(" .footer"))
      return this.nativeShelf?.querySelector(".footer");
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
  { text: "First", start: 0, end: 1000 },
  { text: "Second", start: 1250, end: 2500 },
  { text: "Last", start: 5000, end: 7000 },
];

const transitionLyrics = [
  ...lyrics,
  { text: "Encore", start: 7500, end: 8000 },
];

void test("stages the visible lines behind the new active line and cancels the movement on manual scroll", (context) => {
  const { panel, video, signal, tickFrame } = fixture(context, false);
  Reflect.apply(renderLyrics, null, [panel, video, transitionLyrics, signal]);
  const view = panel.children[0];
  const rows = view?.children[0]?.children;
  assert.ok(view && rows);
  video.currentTime = 1.2;
  video.paused = false;
  video.dispatchEvent(new Event("playing"));
  video.currentTime = 1.25;
  tickFrame();

  assert.equal(rows[1]?.attributes.get("aria-current"), "true");
  assert.equal(rows[1]?.animations.length, 0);
  const first = rows[2]?.animations[0];
  const second = rows[3]?.animations[0];
  assert.ok(first && second);
  assert.equal(first.options.duration, 340);
  assert.equal(first.keyframes[1]?.offset, 0.45);
  assert.equal(first.keyframes[1]?.translate, "0px 4.4px");
  assert.equal(second.keyframes[1]?.translate, "0px 8.8px");
  assert.equal(first.keyframes.at(-1)?.translate, "0px 0px");

  view.dispatchEvent(new Event("wheel"));
  assert.equal(first.playState, "idle");
  assert.equal(second.playState, "idle");
});

void test("keeps the stagger out of seeks and cancels it when Reduce Motion becomes active", (context) => {
  const { panel, video, signal, tickFrame, motionPreference } = fixture(context, false);
  Reflect.apply(renderLyrics, null, [panel, video, transitionLyrics, signal]);
  const rows = panel.children[0]?.children[0]?.children;
  assert.ok(rows);
  video.currentTime = 1.2;
  video.paused = false;
  video.dispatchEvent(new Event("playing"));
  video.seeking = true;
  video.currentTime = 1.25;
  video.dispatchEvent(new Event("seeking"));
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
  assert.equal(rows[2]?.animations.length, 0);

  video.seeking = true;
  video.currentTime = 1.2;
  video.dispatchEvent(new Event("seeking"));
  video.seeking = false;
  video.dispatchEvent(new Event("seeked"));
  video.currentTime = 1.25;
  tickFrame();
  const animation = rows[2]?.animations[0];
  assert.ok(animation);
  motionPreference.matches = true;
  motionPreference.dispatchEvent(new Event("change"));
  assert.equal(animation.playState, "idle");
  assert.equal(rows[1]?.attributes.get("aria-current"), "true");
});

void test("fills the current line continuously within its cue and recomputes on seek", (context) => {
  const { panel, video, signal, tickFrame } = fixture(context, false);
  Reflect.apply(renderLyrics, null, [panel, video, lyrics, signal]);
  const row = panel.children[0]?.children[0]?.children[0];
  assert.ok(row);
  assert.equal(row.style.getPropertyValue("--youtube-tools-lyrics-progress"), "0%");
  video.paused = false;
  video.dispatchEvent(new Event("playing"));
  video.currentTime = 0.6;
  tickFrame();
  assert.equal(row.style.getPropertyValue("--youtube-tools-lyrics-progress"), "60%");
  video.readyState = 1;
  video.dispatchEvent(new Event("waiting"));
  video.currentTime = 0.8;
  tickFrame();
  assert.equal(row.style.getPropertyValue("--youtube-tools-lyrics-progress"), "60%");
  video.paused = true;
  video.dispatchEvent(new Event("pause"));
  video.currentTime = 0.25;
  video.dispatchEvent(new Event("seeked"));
  assert.equal(row.style.getPropertyValue("--youtube-tools-lyrics-progress"), "25%");
});

void test("counts down a three-second instrumental gap without treating overlapping lines as silence", (context) => {
  const { panel, video, signal } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, video, [
    { text: "First", start: 0, end: 5000 },
    { text: "Overlapping", start: 1000, end: 2000 },
    { text: "Before the gap", start: 5200, end: 6000 },
    { text: "After the gap", start: 9000, end: 10000 },
  ], signal]);
  const list = panel.children[0]?.children[0];
  const counters = list?.children.filter((child) =>
    child.className === "youtube-tools-lyrics-instrumental"
  );
  assert.equal(counters?.length, 1);
  const counter = counters?.[0];
  assert.ok(counter);
  assert.equal(counter.hidden, true);
  video.currentTime = 6;
  video.dispatchEvent(new Event("seeked"));
  assert.equal(counter.hidden, false);
  assert.equal(counter.textContent, "♪ 0:03");
  video.currentTime = 8.25;
  video.dispatchEvent(new Event("timeupdate"));
  assert.equal(counter.textContent, "♪ 0:01");
  video.currentTime = 9;
  video.dispatchEvent(new Event("seeked"));
  assert.equal(counter.hidden, true);
  assert.equal(list?.children.at(-1)?.attributes.get("aria-current"), "true");
});

void test("scrolls plain lyrics to playback progress and resumes four seconds after manual scroll", async (context) => {
  const { panel, video, signal, end } = fixture(context);
  panel.scrollHeight = 1000;
  video.duration = 200;
  video.currentTime = 50;
  const { followPlainLyrics } = await import("../src/music-lyrics-view.ts");
  Reflect.apply(followPlainLyrics, null, [panel, video, signal]);
  assert.equal(panel.scrollTop, 200);

  panel.scrollTop = 320;
  panel.dispatchEvent(new Event("scroll"));
  video.currentTime = 150;
  video.dispatchEvent(new Event("seeked"));
  context.mock.timers.tick(3999);
  assert.equal(panel.scrollTop, 320);
  context.mock.timers.tick(1);
  assert.equal(panel.scrollTop, 600);

  video.currentTime = 200;
  video.dispatchEvent(new Event("ended"));
  assert.equal(panel.scrollTop, 800);
  end();
  video.currentTime = 0;
  video.dispatchEvent(new Event("seeked"));
  assert.equal(panel.scrollTop, 800);
});

void test("the source follows the lyrics and selecting a row seeks without resuming playback", (context) => {
  const { panel, video, signal } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, video, lyrics, signal]);
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
  const { panel, video, signal, source, notifySource } = fixture(context);
  source.textContent = "";
  Reflect.apply(renderLyrics, null, [panel, video, lyrics, signal]);
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
  const { panel, video, signal, browserWindow } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, video, lyrics, signal]);
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
  const { panel, video, signal } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, video, lyrics, signal]);
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
  const { panel, video, signal, end } = fixture(context);
  Reflect.apply(renderLyrics, null, [panel, video, lyrics, signal]);
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

function fixture(context: TestContext, reducedMotion = true) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const panel = new Element("ytmusic-tab-renderer");
  const shelf = new Element("ytmusic-description-shelf-renderer");
  const source = new Element("yt-formatted-string");
  source.className = "footer";
  source.textContent = "Source: Example";
  shelf.append(source);
  panel.nativeShelf = shelf;
  const video = new Element("video");
  let sourceChange: (() => void) | undefined;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const motionPreference = Object.assign(new EventTarget(), { matches: reducedMotion });
  const browserWindow = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    matchMedia: () => motionPreference,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
  });
  const environment = {
    document: { createElement: (tag: string) => new Element(tag) },
    window: browserWindow,
    HTMLButtonElement: Element,
    getComputedStyle: () => ({ translate: "none" }),
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
    video,
    browserWindow,
    motionPreference,
    source,
    tickFrame: () => {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(0);
      }
    },
    notifySource: () => {
      sourceChange?.();
    },
    signal: controller.signal,
    end: () => {
      controller.abort();
    },
  };
}
