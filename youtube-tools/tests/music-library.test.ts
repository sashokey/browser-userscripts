import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const file = process.env.YOUTUBE_TOOLS_ARTIFACT ?? "youtube-tools.user.js";
const code = await readFile(new URL(`../${file}`, import.meta.url), "utf8");

function bookmark(saved: boolean, track: number) {
  return {
    isToggled: saved,
    defaultIcon: { iconType: "BOOKMARK_BORDER" },
    toggledIcon: { iconType: "BOOKMARK" },
    defaultText: { runs: [{ text: "Сохранить в библиотеке" }] },
    toggledText: { runs: [{ text: "Удалить из библиотеки" }] },
    defaultServiceEndpoint: {
      feedbackEndpoint: { feedbackToken: `add-${track}` },
    },
    toggledServiceEndpoint: {
      feedbackEndpoint: { feedbackToken: `remove-${track}` },
    },
  };
}

class Element extends EventTarget {
  readonly attributes = new Map<string, string>();
  readonly children: Element[] = [];
  parentElement: Element | null = null;
  data: unknown;
  active = false;
  hidden = false;
  textContent = "";
  type = "";
  title = "";
  readonly name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }
  get isConnected(): boolean {
    return this.name === "ytmusic-app" || !!this.parentElement?.isConnected;
  }
  get firstElementChild(): Element | undefined {
    return this.children[0];
  }
  get previousElementSibling(): Element | undefined {
    const siblings = this.parentElement?.children;
    return siblings?.[siblings.indexOf(this) - 1];
  }
  get nextElementSibling(): Element | undefined {
    const siblings = this.parentElement?.children;
    return siblings?.[siblings.indexOf(this) + 1];
  }
  append(...nodes: Element[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
      node.connectedCallback();
    }
  }
  connectedCallback(): void {}
  before(node: Element): void {
    this.insert(node, 0);
  }
  after(node: Element): void {
    this.insert(node, 1);
  }
  insert(node: Element, offset: number): void {
    node.remove();
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this) + offset, 0, node);
    node.parentElement = parent;
  }
  remove(): void {
    const parent = this.parentElement;
    if (parent) parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((child) => child.contains(node));
  }
  toggleAttribute(): void {}
  matches(selector: string): boolean {
    return selector.split(",").some((part) => part.trim() === this.name);
  }
  closest(selector: string): Element | null {
    return this.matches(selector)
      ? this
      : (this.parentElement?.closest(selector) ?? null);
  }
  querySelectorAll(selector: string): Element[] {
    const names = selector
      .split(",")
      .map((part) => part.trim().split(" ").at(-1));
    return this.children.flatMap((child) => [
      ...(names.includes(child.name) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): Element | null {
    if (
      this.name === "ytmusic-toggle-menu-service-item-renderer" &&
      selector === "yt-formatted-string"
    ) {
      const label = new Element(selector);
      label.textContent = this.active
        ? "Удалить из библиотеки"
        : "Сохранить в библиотеке";
      return label;
    }
    return this.querySelectorAll(selector)[0] ?? null;
  }
  click(): void {
    this.dispatchEvent(new Event("click", { cancelable: true }));
  }
}

function openMusic(mobile: boolean, saved: boolean | undefined) {
  const nativeTag = "ytmusic-toggle-menu-service-item-renderer";
  const modelTracks = new Map<unknown, number>();
  const library = new Map<number, boolean>();
  let track = 0;
  class NativeItem extends Element {
    constructor() {
      super(nativeTag);
    }
    override connectedCallback(): void {
      const id = modelTracks.get(this.data);
      this.active = id !== undefined && library.get(id) === true;
    }
    override click(): void {
      const id = modelTracks.get(this.data);
      if (id === undefined) return;
      this.active = !this.active;
      const active = this.active;
      const event = new CustomEvent("yt-action", {
        detail: { actionName: "yt-service-request" },
      });
      Object.defineProperty(event, "target", { value: this });
      document.dispatchEvent(event);
      queueMicrotask(() => library.set(id, active));
    }
  }
  const app = new Element("ytmusic-app");
  const bar = new Element(
    mobile ? "ytmusic-player-page" : "ytmusic-player-bar",
  );
  const row = new Element(
    mobile ? ".content-info-wrapper" : ".middle-controls-buttons",
  );
  const anchor = new Element(
    mobile ? ".title" : "ytmusic-like-button-renderer",
  );
  const menu = new Element(
    mobile
      ? "ytmusic-menu-renderer.context-menu-button"
      : "ytmusic-menu-renderer",
  );
  const menuPrototype: unknown = Object.create(Reflect.getPrototypeOf(menu));
  assert.ok(menuPrototype && typeof menuPrototype === "object");
  let menuData: unknown;
  Object.defineProperty(menuPrototype, "data", {
    get: () => menuData,
    set(value: unknown) {
      menuData = value;
    },
  });
  Reflect.deleteProperty(menu, "data");
  Object.setPrototypeOf(menu, menuPrototype);
  const controls = new Element("ytmusic-player-controls");
  app.append(bar);
  if (mobile) {
    bar.append(menu, controls);
    controls.append(row);
    row.append(anchor, new Element(".byline-wrapper"));
  } else {
    bar.append(row);
    row.append(anchor, menu);
  }
  function changeTrack(state: boolean | undefined): void {
    track++;
    const model = state === undefined ? undefined : bookmark(state, track);
    if (model) modelTracks.set(model, track);
    if (state !== undefined) library.set(track, state);
    menu.data = {
      items: [
        {
          toggleMenuServiceItemRenderer: {
            defaultIcon: { iconType: "FAVORITE" },
          },
        },
        ...(model === undefined
          ? []
          : [{ toggleMenuServiceItemRenderer: model }]),
      ],
    };
  }
  changeTrack(saved);
  const document = Object.assign(new EventTarget(), {
    querySelector: (selector: string) =>
      selector === "ytmusic-app" ? app : app.querySelector(selector),
    documentElement: new Element("html"),
    createElement: (name: string) =>
      name === nativeTag ? new NativeItem() : new Element(name),
    createElementNS: (_namespace: string, name: string) => new Element(name),
  });
  const window = new EventTarget();
  Object.defineProperty(window, "top", { value: window });
  const observers = new Map<object, (records: unknown[]) => void>();
  class Observer {
    readonly callback: (records: unknown[]) => void;
    constructor(callback: (records: unknown[]) => void) {
      this.callback = callback;
    }
    observe(node: object): void {
      observers.set(node, this.callback);
    }
    disconnect(): void {
      for (const [target, callback] of observers) {
        if (callback === this.callback) observers.delete(target);
      }
    }
  }
  runInNewContext(code, {
    document,
    window,
    unsafeWindow: window,
    AbortController,
    Element,
    HTMLElement: Element,
    MutationObserver: Observer,
    location: new URL("https://music.youtube.com/"),
    URLSearchParams,
    queueMicrotask,
    setTimeout,
    GM_addStyle() {},
  });
  return {
    row,
    anchor,
    menu,
    changeTrack,
    clickMenu: (otherTrack = false) => {
      const id = otherTrack ? track + 1 : track;
      const model = bookmark(library.get(id) === true, id);
      modelTracks.set(model, id);
      const action = new NativeItem();
      action.data = model;
      app.append(action);
      action.click();
      action.remove();
    },
    refresh: () =>
      observers.get(app)?.([{ target: row, addedNodes: [], removedNodes: [] }]),
    button: () => row.children.find((child) => child.name === "button"),
  };
}

for (const mobile of [false, true]) {
  void test(`Music refreshes the ${mobile ? "mobile" : "desktop"} shortcut when menu data changes without a DOM mutation`, async () => {
    const player = openMusic(mobile, undefined);
    assert.equal(player.button(), undefined);
    player.changeTrack(false);
    await Promise.resolve();
    const button = player.button();
    assert.equal(button?.getAttribute("aria-label"), "Сохранить в библиотеке");
    player.changeTrack(true);
    await Promise.resolve();
    assert.equal(player.button(), button);
    assert.equal(button?.getAttribute("aria-label"), "Удалить из библиотеки");
    player.changeTrack(undefined);
    await Promise.resolve();
    assert.equal(player.button(), undefined);
  });

  void test(`Music attaches the library shortcut by the ${mobile ? "mobile title" : "desktop likes"}`, () => {
    const player = openMusic(mobile, false);
    const button = player.button();
    assert.ok(button, "missing player library button");
    assert.equal(
      player.row.children[player.row.children.indexOf(player.anchor) + 1],
      button,
    );
    assert.equal(button.getAttribute("aria-label"), "Сохранить в библиотеке");
    const icon = button.firstElementChild?.firstElementChild;
    const outline = icon?.getAttribute("d");
    assert.ok(outline);

    button.click();
    assert.equal(button.getAttribute("aria-label"), "Удалить из библиотеки");
    assert.notEqual(icon?.getAttribute("d"), outline);
    button.click();
    assert.equal(button.getAttribute("aria-label"), "Сохранить в библиотеке");
    assert.equal(icon?.getAttribute("d"), outline);

    player.changeTrack(true);
    button.click();
    player.refresh();
    player.refresh();
    assert.equal(player.button(), button, "the focusable button was replaced");
    assert.equal(
      player.row.children.filter((child) => child.name === "button").length,
      1,
    );
    assert.equal(
      player.button()?.getAttribute("aria-label"),
      "Удалить из библиотеки",
    );

    player.changeTrack(undefined);
    player.refresh();
    assert.equal(player.button(), undefined);
  });

  void test(`Music follows native menu changes in the ${mobile ? "mobile player" : "desktop player"}`, async () => {
    const player = openMusic(mobile, false);
    player.clickMenu();
    await delay(0);
    assert.equal(
      player.button()?.getAttribute("aria-label"),
      "Удалить из библиотеки",
    );
    player.clickMenu(true);
    await delay(0);
    assert.equal(
      player.button()?.getAttribute("aria-label"),
      "Удалить из библиотеки",
    );
    player.clickMenu();
    await delay(0);
    assert.equal(
      player.button()?.getAttribute("aria-label"),
      "Сохранить в библиотеке",
    );
  });
}
