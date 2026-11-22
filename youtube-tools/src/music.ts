import { observeAppTree } from "./dom.ts";

const audioTracks = new Set([
  "MUSIC_VIDEO_TYPE_ATV",
  "MUSIC_VIDEO_TYPE_PRIVATELY_OWNED_TRACK",
]);
const appSelector = "ytmusic-app";
const musicRows =
  "ytmusic-two-row-item-renderer,ytmusic-responsive-list-item-renderer,ytmusic-card-shelf-renderer,ytmusic-player-queue-item";
const filtered = "data-youtube-tools-video";
const blocked = "data-youtube-tools-blocked";
const queueSelector = "ytmusic-player-queue,ytmusic-player-queue-item";

type Track = { id: string; allowed: boolean };
type Pending = {
  queue: object;
  player: object;
  id: string;
  index: number;
  previous?: string;
  step: 1 | -1;
};
type Guard = { owner: object; wrapper: unknown; get?: () => unknown };

function ownProperty(
  owner: object,
  key: string,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(owner, key);
  } catch {}
}

function observeAssignment(
  owner: object,
  key: string,
  property: PropertyDescriptor | undefined,
  get: () => unknown,
  update: (value: unknown) => void,
): boolean {
  if (!property?.configurable || !property.writable) return false;
  try {
    return Reflect.defineProperty(owner, key, {
      configurable: true,
      enumerable: property.enumerable ?? false,
      get,
      set(this: object, value: unknown) {
        if (this === owner) update(value);
        else
          Object.defineProperty(this, key, {
            value,
            configurable: true,
            enumerable: true,
            writable: true,
          });
      },
    });
  } catch {
    return false;
  }
}

function object(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function read(value: unknown, ...keys: string[]): unknown {
  try {
    for (const key of keys) {
      if (!object(value)) return;
      value = Reflect.get(value, key);
    }
    return value;
  } catch {}
}

function invoke(owner: unknown, key: string): unknown {
  const method = read(owner, key);
  if (typeof method !== "function") return;
  try {
    return Reflect.apply(method, owner, []);
  } catch {}
}

function id(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
}

function savedTrack(data: unknown): boolean {
  const items = read(data, "menu", "menuRenderer", "items");
  return (
    Array.isArray(items) &&
    items.some((item: unknown) => {
      const toggle = read(item, "toggleMenuServiceItemRenderer");
      return (
        read(toggle, "defaultIcon", "iconType") === "BOOKMARK_BORDER" &&
        read(toggle, "toggledIcon", "iconType") === "BOOKMARK"
      );
    })
  );
}

function track(data: unknown): Track | undefined {
  const endpoints = [
    read(data, "navigationEndpoint", "watchEndpoint"),
    read(data, "onTap", "watchEndpoint"),
    read(
      data,
      "flexColumns",
      "0",
      "musicResponsiveListItemFlexColumnRenderer",
      "text",
      "runs",
      "0",
      "navigationEndpoint",
      "watchEndpoint",
    ),
  ];
  const videoId =
    id(read(data, "videoId")) ??
    id(read(data, "playlistItemData", "videoId")) ??
    endpoints.map((endpoint) => id(read(endpoint, "videoId"))).find(Boolean);
  if (!videoId) return;
  for (const endpoint of endpoints) {
    if (read(endpoint, "videoId") !== videoId) continue;
    const kind = read(
      endpoint,
      "watchEndpointMusicSupportedConfigs",
      "watchEndpointMusicConfig",
      "musicVideoType",
    );
    if (typeof kind === "string")
      return { id: videoId, allowed: audioTracks.has(kind) };
  }
  return { id: videoId, allowed: savedTrack(data) };
}

function queueTrack(item: unknown): Track | undefined {
  return track(
    read(item, "playlistPanelVideoRenderer") ??
      read(
        item,
        "playlistPanelVideoWrapperRenderer",
        "primaryRenderer",
        "playlistPanelVideoRenderer",
      ),
  );
}

function items(queue: object): unknown[] {
  const list = invoke(queue, "getItems");
  return Array.isArray(list) ? list : [];
}

function currentIndex(queue: object): number {
  const index = invoke(queue, "getCurrentItemIndex");
  return typeof index === "number" && Number.isSafeInteger(index) ? index : -1;
}

function playerTrack(player: unknown, candidate: string): boolean | undefined {
  try {
    const details = read(invoke(player, "getPlayerResponse"), "videoDetails");
    if (read(details, "videoId") !== candidate) return;
    const kind = read(details, "musicVideoType");
    if (typeof kind === "string") return audioTracks.has(kind);
  } catch {}
}

function watchId(): string | undefined {
  if (location.pathname === "/watch")
    return id(new URLSearchParams(location.search).get("v"));
}

function repeatAll(): boolean {
  return (
    read(document.querySelector("ytmusic-player-bar"), "repeatMode") === "ALL"
  );
}

export function music(): void {
  let app: Element | null = null;
  let queue: object | undefined;
  let currentPlayer: object | undefined;
  let previous: { id: string; index: number; item: unknown } | undefined;
  let pending: Pending | undefined;
  const patched = new WeakMap<object, Map<string, Guard>>();
  const watchedPlayers = new WeakMap<object, () => unknown>();

  GM_addStyle(`[${filtered}]{display:none!important}
    :root[${blocked}] ytmusic-player,
    :root[${blocked}] ytmusic-player-bar .content-info-wrapper,
    :root[${blocked}] ytmusic-player-bar .thumbnail-image-wrapper{visibility:hidden!important}`);

  function block(value: boolean): void {
    document.documentElement?.toggleAttribute(blocked, value);
  }

  function stillActive(owner: object, player: object): boolean {
    return (
      !!app?.isConnected &&
      queue === owner &&
      currentPlayer === player &&
      read(app, "queue") === owner &&
      read(owner, "playerApi") === player
    );
  }

  function advance(request: Pending): void {
    if (pending !== request) return;
    const owner = request.queue;
    if (!stillActive(owner, request.player)) {
      pending = undefined;
      return;
    }
    const rows = items(owner);
    const current = currentIndex(owner);
    const selected = queueTrack(rows[current])?.id;
    if (selected !== request.id && selected !== request.previous) return;
    const rejected =
      selected === request.id
        ? current
        : queueTrack(rows[request.index])?.id === request.id
          ? request.index
          : rows.findIndex((item) => queueTrack(item)?.id === request.id);
    if (rejected < 0) return;
    const repeat = repeatAll();
    for (let count = 1; count < rows.length; count++) {
      const next = rejected + count * request.step;
      if (!repeat && (next < 0 || next >= rows.length)) break;
      const index = (next + rows.length) % rows.length;
      const item = rows[index];
      if (!queueTrack(item)?.allowed) continue;
      const select = read(owner, "selectQueueItem");
      pending = undefined;
      if (typeof select === "function" && stillActive(owner, request.player))
        Reflect.apply(select, owner, [item]);
      return;
    }
  }

  function allow(
    owner: object,
    player: object,
    target: string,
    selecting: boolean,
  ): boolean {
    const rows = items(owner);
    const current = currentIndex(owner);
    const selected = queueTrack(rows[current]);
    const next =
      selected?.id === target
        ? current
        : rows.findIndex((item) => queueTrack(item)?.id === target);
    const result = queueTrack(rows[next]);
    const allowed = playerTrack(player, target) ?? result?.allowed ?? false;
    if (!selecting) return allowed;
    if (allowed) {
      pending = undefined;
      previous = { id: target, index: next, item: rows[next] };
      block(false);
      return true;
    }
    if (
      watchId() === target &&
      !new URLSearchParams(location.search).get("list")
    ) {
      pending = undefined;
      block(true);
      invoke(player, "pauseVideo");
      return false;
    }
    if (!previous || previous.id === target) block(true);
    const old =
      previous &&
      (queueTrack(rows[previous.index])?.id === previous.id
        ? previous.index
        : rows.indexOf(previous.item));
    if (next < 0) {
      pending = undefined;
      return false;
    }
    let step: 1 | -1 = old !== undefined && next < old ? -1 : 1;
    if (repeatAll()) {
      if (old === rows.length - 1 && next === 0) step = 1;
      if (old === 0 && next === rows.length - 1) step = -1;
    }
    const request: Pending = {
      queue: owner,
      player,
      id: target,
      index: next,
      ...(selected ? { previous: selected.id } : {}),
      step,
    };
    pending = request;
    queueMicrotask(() => advance(request));
    return false;
  }

  function guard(owner: object, player: object): void {
    let methods = patched.get(player);
    if (!methods) {
      methods = new Map();
      patched.set(player, methods);
    }
    for (const name of [
      "loadVideoByPlayerVars",
      "cueVideoByPlayerVars",
      "enqueueVideoByPlayerVars",
      "playVideo",
    ] as const) {
      const descriptor = ownProperty(player, name);
      const last = methods.get(name);
      if (last?.get && descriptor?.get === last.get) {
        last.owner = owner;
        continue;
      }
      if (descriptor && !descriptor.writable) continue;
      const current = read(player, name);
      if (last && last.wrapper === current) {
        last.owner = owner;
        continue;
      }
      if (typeof current !== "function") continue;
      const entry: Guard = { owner, wrapper: undefined };
      function wrap(value: unknown): unknown {
        if (typeof value !== "function") return value;
        return new Proxy(value, {
          apply(method, receiver: unknown, args: unknown[]) {
            const owner = entry.owner;
            if (stillActive(owner, player)) {
              const selecting = name !== "enqueueVideoByPlayerVars";
              const target =
                name === "playVideo"
                  ? (id(read(invoke(player, "getVideoData"), "video_id")) ??
                    queueTrack(items(owner)[currentIndex(owner)])?.id ??
                    watchId())
                  : (id(read(args[0], "video_id")) ??
                    id(read(args[0], "videoId")));
              if (target && !allow(owner, player, target, selecting)) return;
            }
            const result: unknown = Reflect.apply(method, receiver, args);
            return result;
          },
        });
      }
      entry.wrapper = wrap(current);
      const get = () => entry.wrapper;
      if (
        observeAssignment(player, name, descriptor, get, (replacement) => {
          if (replacement !== entry.wrapper) entry.wrapper = wrap(replacement);
        })
      ) {
        entry.get = get;
        methods.set(name, entry);
        continue;
      }
      try {
        if (Reflect.set(player, name, entry.wrapper)) methods.set(name, entry);
      } catch {}
    }
  }

  function watchPlayer(owner: object): void {
    const property = ownProperty(owner, "playerApi");
    const installed = watchedPlayers.get(owner);
    if (installed && property?.get === installed) return;
    let value = read(owner, "playerApi");
    const get = () => value;
    if (
      observeAssignment(owner, "playerApi", property, get, (replacement) => {
        if (replacement === value) return;
        value = replacement;
        if (app?.isConnected && read(app, "queue") === owner) updateQueue();
      })
    )
      watchedPlayers.set(owner, get);
  }

  function updateQueue(): void {
    const value = read(app, "queue");
    const owner = object(value) ? value : undefined;
    if (owner) watchPlayer(owner);
    const playerValue = read(owner, "playerApi");
    const player = object(playerValue) ? playerValue : undefined;
    if (queue !== owner || currentPlayer !== player) {
      queue = owner;
      currentPlayer = player;
      previous = undefined;
      pending = undefined;
    }
    if (owner && player) guard(owner, player);
  }

  function update(row: Element): void {
    row.toggleAttribute(filtered, track(read(row, "data"))?.allowed === false);
  }

  function collect(node: Node, changed: Set<Element>): void {
    if (!(node instanceof Element)) return;
    if (node.matches(musicRows)) changed.add(node);
    for (const row of node.querySelectorAll(musicRows)) changed.add(row);
  }

  const observer = new MutationObserver((records) => {
    if (!app?.isConnected) return;
    updateQueue();
    const changed = new Set<Element>();
    let queueChanged = false;
    for (const record of records) {
      const element =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      const row = element?.closest(musicRows);
      if (row) changed.add(row);
      queueChanged ||= Boolean(element?.closest(queueSelector));
      for (const node of record.addedNodes) {
        collect(node, changed);
        if (node instanceof Element)
          queueChanged ||=
            node.matches(queueSelector) ||
            Boolean(node.querySelector(queueSelector));
      }
    }
    for (const row of changed) update(row);
    if (pending && queueChanged) advance(pending);
  });
  const lifecycle = new MutationObserver(() => {
    if (!app?.isConnected) attach();
    else observeAppTree(lifecycle, app);
  });

  function attach(): void {
    app = document.querySelector(appSelector);
    observer.disconnect();
    observeAppTree(lifecycle, app);
    updateQueue();
    if (!app) return;
    observer.observe(app, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    for (const row of app.querySelectorAll(musicRows)) update(row);
  }

  block(watchId() !== undefined);
  attach();
  document.addEventListener(
    "play",
    (event) => {
      const video = event.target;
      if (!(video instanceof HTMLVideoElement)) return;
      const player = video.closest("#movie_player");
      if (!player || player.classList.contains("ad-showing")) return;
      updateQueue();
      const target =
        id(read(invoke(player, "getVideoData"), "video_id")) ?? watchId();
      if (!target) return;
      const allowed = queue
        ? allow(queue, player, target, true)
        : (playerTrack(player, target) ?? false);
      block(!allowed);
      if (!allowed) video.pause();
    },
    true,
  );
}
