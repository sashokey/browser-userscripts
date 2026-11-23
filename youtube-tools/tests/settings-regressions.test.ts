import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const artifact = process.env.YOUTUBE_TOOLS_ARTIFACT ?? "youtube-tools.user.js";
const code = await readFile(new URL(`../${artifact}`, import.meta.url), "utf8");

class Element extends EventTarget {
  readonly name: string;
  readonly children: Element[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = {};
  isConnected = true;
  parentElement: Element | null = null;
  shown = true;
  className = "";

  constructor(name: string) {
    super();
    this.name = name;
  }
  get parentNode(): Element | null {
    return this.parentElement;
  }
  getClientRects(): unknown[] {
    return this.shown ? [{}] : [];
  }
  matches(selector: string): boolean {
    return (
      selector === this.name ||
      selector === `.${this.className}` ||
      (this.name === "ytd-browse" &&
        selector === 'ytd-browse[page-subtype="home"]') ||
      (this.name === "ytd-multi-page-menu-renderer" &&
        selector.startsWith(`${this.name}:is(`))
    );
  }
  closest(selector: string): Element | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  append(...items: Element[]): void {
    for (const item of items) {
      item.remove();
      this.children.push(item);
      item.parentElement = this;
    }
  }
  after(item: Element): void {
    item.remove();
    if (!this.parentElement) return;
    this.parentElement.children.splice(
      this.parentElement.children.indexOf(this) + 1,
      0,
      item,
    );
    item.parentElement = this.parentElement;
  }
  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

function open(
  host: string,
  path: string,
  build: (root: Element) => void,
  wrapped = false,
) {
  const location = new URL(path, `https://${host}`);
  const nativeWindow = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
  });
  Object.defineProperty(nativeWindow, "top", { value: nativeWindow });
  const window = wrapped
    ? {
        addEventListener: (
          ...args: Parameters<EventTarget["addEventListener"]>
        ) => nativeWindow.addEventListener(...args),
        setTimeout,
        clearTimeout,
      }
    : nativeWindow;
  if (wrapped) Object.defineProperty(window, "top", { value: window });
  const body = new Element("body");
  const root = new Element(host.startsWith("m.") ? "ytm-app" : "ytd-app");
  body.append(root);
  build(root);
  const document = Object.assign(new EventTarget(), {
    readyState: "complete",
    documentElement: { lang: "en-US" },
    body,
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    createElement: (name: string) => new Element(name),
    createElementNS: (_ns: string, name: string) => new Element(name),
  });
  const changes = new Map<string, (old: unknown, next: unknown) => void>();
  runInNewContext(code, {
    document,
    location,
    window,
    unsafeWindow: nativeWindow,
    Element,
    HTMLElement: Element,
    HTMLAnchorElement: Element,
    AbortController,
    Event,
    URLSearchParams,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    customElements: { whenDefined: () => new Promise<never>(() => {}) },
    getComputedStyle: () => ({ visibility: "visible" }),
    GM_addStyle() {},
    GM_getValue: () => false,
    GM_addValueChangeListener(
      key: string,
      callback: (key: string, before: unknown, after: unknown) => void,
    ) {
      changes.set(key, (before, after) => callback(key, before, after));
    },
  });
  return { root, location, window: nativeWindow, changes };
}

void test("mobile preferences follow the visible settings pane past a retained hidden pane", () => {
  const old = new Element("ytm-settings");
  old.shown = false;
  const current = new Element("ytm-settings");
  open("m.youtube.com", "/select_site", (root) => root.append(old, current));
  assert.equal(old.querySelectorAll(".ytt-setting").length, 0);
  assert.equal(current.querySelectorAll(".ytt-setting").length, 2);
});

void test("a native row getter failure leaves desktop settings and watched filtering active", () => {
  const browse = new Element("ytd-browse");
  const menu = new Element("ytd-multi-page-menu-renderer");
  const invalid = new Element("ytd-compact-link-renderer");
  Object.defineProperty(invalid, "data", {
    get() {
      throw new Error("renderer disposed");
    },
  });
  const anchor = Object.assign(new Element("ytd-compact-link-renderer"), {
    data: { icon: { iconType: "KEYBOARD" } },
  });
  menu.append(invalid, anchor);
  open("www.youtube.com", "/", (root) => {
    const popup = new Element("ytd-popup-container");
    popup.append(menu);
    root.append(popup, browse);
  });
  assert.equal(menu.querySelectorAll(".ytt-setting").length, 2);
  assert.ok(browse.attributes.has("data-ytt-filter"));
});

void test("cached Home filtering responds to desktop navigation dispatched on window", () => {
  const home = new Element("ytd-browse");
  const page = open("www.youtube.com", "/watch?v=aKydtOXW8mI", (root) =>
    root.append(home),
  );
  assert.equal(home.attributes.has("data-ytt-filter"), false);
  page.location.pathname = "/";
  page.window.dispatchEvent(new Event("yt-navigate-finish"));
  assert.ok(home.attributes.has("data-ytt-filter"));
});

void test("cached Home is filtered when Violentmonkey forwards a window-targeted event", () => {
  const home = new Element("ytd-browse");
  const page = open(
    "www.youtube.com",
    "/watch?v=aKydtOXW8mI",
    (root) => root.append(home),
    true,
  );
  page.location.pathname = "/";
  page.window.dispatchEvent(new Event("yt-navigate-finish"));
  assert.ok(home.attributes.has("data-ytt-filter"));
});

void test("removing Show watched restores the default filtering in the open tab", () => {
  const home = new Element("ytd-browse");
  const page = open("www.youtube.com", "/", (root) => root.append(home));
  const changed = page.changes.get("showWatched");
  assert.ok(changed);
  changed(false, true);
  assert.equal(home.attributes.has("data-ytt-filter"), false);
  changed(true, undefined);
  assert.ok(home.attributes.has("data-ytt-filter"));
});
