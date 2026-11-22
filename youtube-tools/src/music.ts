const audioTrack = "MUSIC_VIDEO_TYPE_ATV";
const appSelector = "ytmusic-app";
const musicRows =
  "ytmusic-two-row-item-renderer,ytmusic-responsive-list-item-renderer,ytmusic-card-shelf-renderer,ytmusic-player-queue-item";
const filtered = "data-youtube-tools-video";
const blocked = "data-youtube-tools-blocked";

type Track = { id: string; allowed: boolean };
type Pending = { queue: object; id: string; previous?: string; step: 1 | -1 };
type Guard = { owner: object; original: unknown; wrapper: unknown };

function object(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function read(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (!object(value)) return;
    value = Reflect.get(value, key);
  }
  return value;
}

function invoke(owner: unknown, key: string): unknown {
  const method = read(owner, key);
  if (typeof method === "function") return Reflect.apply(method, owner, []);
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
      return { id: videoId, allowed: kind === audioTrack };
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

function playerTrack(player: unknown, candidate: string): boolean {
  const response = invoke(player, "getPlayerResponse");
  const details = read(response, "videoDetails");
  return (
    read(details, "videoId") === candidate &&
    read(details, "musicVideoType") === audioTrack
  );
}

function watchId(): string | undefined {
  if (location.pathname === "/watch")
    return id(new URLSearchParams(location.search).get("v"));
}

export function music(): void {
  let app: Element | null = null;
  let queue: object | undefined;
  let previous: Track | undefined;
  let pending: Pending | undefined;
  const patched = new WeakMap<object, Map<string, Guard>>();

  GM_addStyle(`[${filtered}]{display:none!important}
    :root[${blocked}] ytmusic-player,
    :root[${blocked}] ytmusic-player-bar .content-info-wrapper,
    :root[${blocked}] ytmusic-player-bar .thumbnail-image-wrapper{visibility:hidden!important}`);

  function block(value: boolean): void {
    document.documentElement?.toggleAttribute(blocked, value);
  }

  function advance(request: Pending): void {
    if (pending !== request || queue !== request.queue) return;
    const rows = items(queue);
    const current = currentIndex(queue);
    const selected = queueTrack(rows[current])?.id;
    if (selected !== request.id && selected !== request.previous) return;
    const rejected =
      selected === request.id
        ? current
        : rows.findIndex((item) => queueTrack(item)?.id === request.id);
    if (rejected < 0) return;
    for (
      let index = rejected + request.step;
      index >= 0 && index < rows.length;
      index += request.step
    ) {
      const item = rows[index];
      if (!queueTrack(item)?.allowed) continue;
      const select = read(queue, "selectQueueItem");
      pending = undefined;
      if (typeof select === "function") Reflect.apply(select, queue, [item]);
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
    const result =
      selected?.id === target
        ? selected
        : rows.map(queueTrack).find((item) => item?.id === target);
    const allowed = result?.allowed ?? playerTrack(player, target);
    if (!selecting) return allowed;
    if (allowed) {
      pending = undefined;
      previous = { id: target, allowed: true };
      block(false);
      return true;
    }
    block(true);
    const old =
      previous &&
      rows.findIndex((item) => queueTrack(item)?.id === previous?.id);
    const next =
      selected?.id === target
        ? current
        : rows.findIndex((item) => queueTrack(item)?.id === target);
    const request: Pending = {
      queue: owner,
      id: target,
      ...(selected ? { previous: selected.id } : {}),
      step: old !== undefined && next >= 0 && next < old ? -1 : 1,
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
      const current = read(player, name);
      const last = methods.get(name);
      if (last?.wrapper === current && last?.owner === owner) continue;
      const native = last && last.wrapper === current ? last.original : current;
      if (typeof native !== "function") continue;
      const guarded = new Proxy(native, {
        apply(method, receiver: unknown, args: unknown[]) {
          const selecting = name !== "enqueueVideoByPlayerVars";
          const target =
            name === "playVideo"
              ? (queueTrack(items(owner)[currentIndex(owner)])?.id ?? watchId())
              : (id(read(args[0], "video_id")) ?? id(read(args[0], "videoId")));
          if (
            queue === owner &&
            target &&
            !allow(owner, player, target, selecting)
          )
            return;
          const result: unknown = Reflect.apply(method, receiver, args);
          return result;
        },
      });
      if (Reflect.set(player, name, guarded)) {
        methods.set(name, { owner, original: native, wrapper: guarded });
      }
    }
  }

  function updateQueue(): void {
    const owner = read(app, "queue");
    if (!object(owner)) return;
    if (queue !== owner) {
      queue = owner;
      previous = undefined;
      pending = undefined;
    }
    const player = read(owner, "playerApi");
    if (object(player)) guard(owner, player);
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
    if (!app) {
      attach();
      return;
    }
    updateQueue();
    const changed = new Set<Element>();
    for (const record of records) {
      const element =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      const row = element?.closest(musicRows);
      if (row) changed.add(row);
      for (const node of record.addedNodes) collect(node, changed);
    }
    for (const row of changed) update(row);
    if (pending) advance(pending);
  });

  function attach(): void {
    app = document.querySelector(appSelector);
    if (!app) return;
    observer.disconnect();
    observer.observe(app, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    updateQueue();
    for (const row of app.querySelectorAll(musicRows)) update(row);
  }

  block(watchId() !== undefined);
  attach();
  if (!app) observer.observe(document, { subtree: true, childList: true });
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
        : playerTrack(player, target);
      block(!allowed);
      if (!allowed) video.pause();
    },
    true,
  );
}
