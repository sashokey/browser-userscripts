import { activation, read, svg } from "./dom.ts";

const mobileMenu = "ytmusic-menu-renderer.context-menu-button";
const menus = [
  "ytmusic-player-bar .middle-controls-buttons > ytmusic-menu-renderer",
  `ytmusic-player-page ${mobileMenu}`,
].join(",");
const players = `ytmusic-player-bar,ytmusic-player-controls,${mobileMenu}`;
const shortcut = "data-youtube-tools-library";
const nativeItem = "ytmusic-toggle-menu-service-item-renderer";
const outline =
  "M14.25 1.5H3.75A1.5 1.5 0 002.25 3v12.665c0 .95 1.037 1.538 1.852 1.049L9 13.774l4.898 2.94a1.223 1.223 0 001.852-1.049V3a1.5 1.5 0 00-1.5-1.5ZM3.75 15.175V3h10.5v12.175l-4.864-2.918L9 12.025l-.386.232-4.864 2.918Z";
const filled =
  "M14.25 1.5H3.75A1.5 1.5 0 002.25 3v12.665c0 .95 1.037 1.538 1.852 1.049L9 13.774l4.898 2.94a1.223 1.223 0 001.852-1.049V3a1.5 1.5 0 00-1.5-1.5Z";

type Shortcut = {
  data: object;
  native: HTMLElement;
  button: HTMLButtonElement;
  icon: SVGSVGElement;
};

export function libraryItem(menu: unknown): object | undefined {
  const items = read(menu, "items");
  if (!Array.isArray(items)) return;
  const candidates: unknown[] = items;
  for (const item of candidates) {
    const toggle = read(item, "toggleMenuServiceItemRenderer");
    if (
      toggle !== null &&
      typeof toggle === "object" &&
      read(toggle, "defaultIcon", "iconType") === "BOOKMARK_BORDER" &&
      read(toggle, "toggledIcon", "iconType") === "BOOKMARK"
    )
      return toggle;
  }
}

export function libraryMutation(record: MutationRecord): boolean {
  const target =
    record.target instanceof Element
      ? record.target
      : record.target.parentElement;
  if (target?.closest(players)) return true;
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) =>
      node instanceof Element &&
      (node.matches(players) || node.querySelector(players) !== null),
  );
}

function render({ button, native, icon }: Shortcut): void {
  const label = native
    .querySelector("yt-formatted-string")
    ?.textContent?.trim();
  button.hidden = !label;
  if (!label) return;
  const path = read(native, "active") === true ? filled : outline;
  const shape = icon.firstElementChild;
  if (shape?.getAttribute("d") !== path) shape?.setAttribute("d", path);
  if (button.title !== label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

function remove({ button, native }: Shortcut): void {
  button.remove();
  native.remove();
}

function bookmarkToken(data: unknown): string | undefined {
  const token = read(
    data,
    "defaultServiceEndpoint",
    "feedbackEndpoint",
    "feedbackToken",
  );
  if (typeof token === "string" && token.length > 0) return token;
}

function mountNative(menu: Element, data: object): HTMLElement {
  const native = document.createElement(nativeItem);
  native.hidden = true;
  Reflect.set(native, "data", data);
  menu.append(native);
  return native;
}

function watchMenuData(
  menu: Element,
  changed: () => void,
): (() => void) | undefined {
  try {
    const own = Object.getOwnPropertyDescriptor(menu, "data");
    if (own && !own.configurable) return;
    let descriptor = own;
    for (
      let prototype = Reflect.getPrototypeOf(menu);
      !descriptor && prototype;
      prototype = Reflect.getPrototypeOf(prototype)
    )
      descriptor = Object.getOwnPropertyDescriptor(prototype, "data");
    if (!descriptor) return;
    const getter: unknown = Reflect.get(descriptor, "get");
    const setter: unknown = Reflect.get(descriptor, "set");
    if (typeof getter !== "function" || typeof setter !== "function") return;
    const update = function (this: unknown, value: unknown): void {
      Reflect.apply(setter, this, [value]);
      if (this === menu) changed();
    };
    if (
      !Reflect.defineProperty(menu, "data", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        get(this: unknown): unknown {
          return Reflect.apply(getter, this, []);
        },
        set: update,
      })
    )
      return;
    return () => {
      if (Object.getOwnPropertyDescriptor(menu, "data")?.set !== update) return;
      if (own) Reflect.defineProperty(menu, "data", own);
      else Reflect.deleteProperty(menu, "data");
    };
  } catch {}
}

export function musicLibrary(): (app: Element | null) => void {
  const mounted = new Map<Element, Shortcut>();
  const watched = new Map<Element, () => void>();
  let root: Element | null = null;
  let queued = false;
  function schedule(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync(root?.isConnected ? root : null);
    });
  }
  GM_addStyle(`
    button[${shortcut}]{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:transparent;color:#f1f1f1;cursor:pointer}
    button[${shortcut}][hidden]{display:none}
    button[${shortcut}]:focus-visible{outline:2px solid currentColor;outline-offset:-2px}
    @media(hover:hover){button[${shortcut}]:hover{background:rgba(255,255,255,.1)}}
    button[${shortcut}] svg{width:24px;height:24px;fill:currentColor;pointer-events:none}
    ytmusic-player-controls .content-info-wrapper:has(>button[${shortcut}]:not([hidden])){display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px}
    ytmusic-player-controls .content-info-wrapper:has(>button[${shortcut}]:not([hidden]))>.byline-wrapper{grid-column:1/-1}
    button[${shortcut}="mobile"]{width:44px;height:44px}
  `);
  document.addEventListener(
    "yt-action",
    (event) => {
      const source = event.target;
      if (
        !(source instanceof Element) ||
        !source.matches(nativeItem) ||
        read(event, "detail", "actionName") !== "yt-service-request"
      )
        return;
      const token = bookmarkToken(read(source, "data"));
      if (token === undefined) return;
      setTimeout(() => {
        for (const [menu, control] of mounted) {
          if (
            control.native === source ||
            !menu.isConnected ||
            bookmarkToken(control.data) !== token ||
            libraryItem(read(menu, "data")) !== control.data
          )
            continue;
          control.native.remove();
          control.native = mountNative(menu, control.data);
          render(control);
        }
      }, 0);
    },
    true,
  );
  function sync(app: Element | null): void {
    root = app;
    const available = new Set(app?.querySelectorAll(menus) ?? []);
    const present = new Set<Element>();
    for (const menu of available) {
      if (!watched.has(menu)) {
        const dispose = watchMenuData(menu, schedule);
        if (dispose) watched.set(menu, dispose);
      }
      const mobile = menu.matches(mobileMenu);
      const anchor = mobile
        ? menu
            .closest("ytmusic-player-page")
            ?.querySelector(
              "ytmusic-player-controls .content-info-wrapper > .title",
            )
        : menu;
      const data = libraryItem(read(menu, "data"));
      if (!anchor?.parentElement || !data) continue;
      present.add(menu);
      let control = mounted.get(menu);
      if (!control) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute(shortcut, mobile ? "mobile" : "desktop");
        const icon = svg(outline);
        icon.setAttribute("viewBox", "0 0 18 18");
        button.append(icon);
        const current = { data, native: mountNative(menu, data), button, icon };
        activation(button, () => {
          if (
            !current.native.isConnected ||
            libraryItem(read(menu, "data")) !== current.data
          )
            return;
          current.native.click();
          render(current);
        });
        mounted.set(menu, current);
        control = current;
      } else if (
        control.data !== data ||
        control.native.parentElement !== menu
      ) {
        control.native.remove();
        control.native = mountNative(menu, data);
        control.data = data;
      }
      if (mobile) {
        if (anchor.nextElementSibling !== control.button)
          anchor.after(control.button);
      } else if (anchor.previousElementSibling !== control.button)
        anchor.before(control.button);
      render(control);
    }
    for (const [menu, control] of mounted) {
      if (present.has(menu)) continue;
      remove(control);
      mounted.delete(menu);
    }
    for (const [menu, dispose] of watched) {
      if (available.has(menu)) continue;
      dispose();
      watched.delete(menu);
    }
  }
  return sync;
}
