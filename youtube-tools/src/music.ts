import { navigation, observeAppTree, read } from "./dom.ts";
import { libraryItem, libraryMutation, musicLibrary } from "./music-library.ts";
import { musicLyrics } from "./music-lyrics.ts";

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
const playbackMethods = [
  "loadVideoByPlayerVars",
  "cueVideoByPlayerVars",
  "enqueueVideoByPlayerVars",
  "playVideo",
] as const;
type PlaybackMethod = (typeof playbackMethods)[number];
const queueTimeout = 8000;

type Track = { id: string; allowed: boolean | undefined };
type Selection = { id: string; index: number; item: unknown; list?: string };
type Refill = {
  tokens: Set<string>;
  request: unknown;
  timeout: ReturnType<typeof setTimeout>;
};
type Pending = {
  queue: object;
  player: object;
  id: string;
  index: number;
  previous?: string;
  origin?: Selection;
  list?: string;
  requestedList?: string;
  initialUrl: string;
  refill?: Refill;
  recoverClip?: boolean;
  step: 1 | -1;
};
type Guard = {
  owner: object;
  original: unknown;
  wrapper: unknown;
  get?: () => unknown;
};
type Load = { list: string | undefined; replay?: () => void };

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

function invoke(owner: unknown, key: string, ...args: unknown[]): unknown {
  const method = read(owner, key);
  if (typeof method !== "function") return;
  try {
    return Reflect.apply(method, owner, args);
  } catch {}
}

function id(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
}

function videoArgument(value: unknown): string | undefined {
  return id(read(value, "video_id")) ?? id(read(value, "videoId"));
}

function playlistArgument(value: unknown): string | undefined {
  return (
    id(read(value, "playlist_id")) ??
    id(read(value, "playlistId")) ??
    id(read(value, "list"))
  );
}

function savedTrack(data: unknown): boolean {
  return libraryItem(read(data, "menu", "menuRenderer")) !== undefined;
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
  return { id: videoId, allowed: savedTrack(data) || undefined };
}

function queueRenderer(item: unknown): unknown {
  return (
    read(item, "playlistPanelVideoRenderer") ??
    read(
      item,
      "playlistPanelVideoWrapperRenderer",
      "primaryRenderer",
      "playlistPanelVideoRenderer",
    )
  );
}

function queueTrack(item: unknown): Track | undefined {
  return track(queueRenderer(item));
}

function queueList(item: unknown): string | undefined {
  return id(
    read(
      queueRenderer(item),
      "navigationEndpoint",
      "watchEndpoint",
      "playlistId",
    ),
  );
}

function allowsQueueTrack(
  track: Track | undefined,
  index: number,
  list: string | undefined,
  selection: Selection | undefined,
): boolean {
  return (
    track?.allowed ??
    (track !== undefined &&
      selection?.id === track.id &&
      selection.index === index &&
      selection.list === list)
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

function currentList(): string | undefined {
  if (location.pathname === "/watch" || location.pathname === "/playlist")
    return id(new URLSearchParams(location.search).get("list"));
}

function watchList(): string | undefined {
  if (location.pathname === "/watch") return currentList();
}

function playbackVideo(player: unknown): string | null | undefined {
  const playing = id(read(invoke(player, "getVideoData"), "video_id"));
  const direct =
    document.documentElement?.hasAttribute(blocked) && !watchList()
      ? watchId()
      : undefined;
  if (!direct) return playing;
  if (playing && playing !== direct) return null;
  const response = id(
    read(invoke(player, "getPlayerResponse"), "videoDetails", "videoId"),
  );
  return response && response !== direct ? null : direct;
}

function matchesListlessStart(request: Pending): boolean {
  const list = request.list;
  if (!list || watchId() !== request.id || watchList()) return false;
  const from = new URL(request.initialUrl);
  const fromList = from.searchParams.get("list");
  return (
    ((from.pathname === "/playlist" && fromList === list) ||
      (request.requestedList === list &&
        (from.pathname !== "/watch" || fromList !== list))) &&
    queueList(items(request.queue)[currentIndex(request.queue)]) === list
  );
}

function matchesWatch(request: Pending): boolean {
  const video = watchId();
  const list = currentList();
  return (
    location.href === request.initialUrl ||
    (video === undefined
      ? !list || list === request.list
      : list === request.list &&
        (video === request.origin?.id || video === request.id))
  );
}

function infiniteQueue(store: unknown): boolean {
  return read(invoke(store, "getState"), "queue", "isInfinite") === true;
}

function repeatAll(): boolean {
  return (
    read(document.querySelector("ytmusic-player-bar"), "repeatMode") === "ALL"
  );
}

function skipDirection(
  from: number | undefined,
  to: number,
  count: number,
  repeat: boolean,
): 1 | -1 {
  if (repeat && from === count - 1 && to === 0) return 1;
  if (repeat && from === 0 && to === count - 1) return -1;
  return from !== undefined && to < from ? -1 : 1;
}

export function music(): void {
  const syncLibrary = musicLibrary();
  const syncLyrics = musicLyrics((video) => {
    const player = video.closest("#movie_player");
    const playing = id(read(invoke(player, "getVideoData"), "video_id"));
    const route = watchId();
    if (!route || !playing || route === playing) return route ?? playing;
  }, () => id(invoke(read(unsafeWindow, "ytcfg"), "get", "INNERTUBE_CLIENT_VERSION")));
  let app: Element | null = null;
  let appLifetime: AbortController | undefined;
  let queue: object | undefined;
  let currentPlayer: object | undefined;
  let previous: Selection | undefined;
  let prior: Selection | undefined;
  let pending: Pending | undefined;
  let deferredLoad: { retry: () => void; cancel: () => void } | undefined;
  let preservingPlayer: object | undefined;
  let mediaRestore: { request: Pending; song: string } | undefined;
  let completed:
    { list: string; origin: string; tokens: Set<string> } | undefined;
  const patched = new WeakMap<object, Map<string, Guard>>();
  const watchedPlayers = new WeakMap<object, () => unknown>();
  const confirmedTracks = new Map<string, boolean>();

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

  function stopPending(): void {
    if (pending?.refill) clearTimeout(pending.refill.timeout);
    pending = undefined;
  }

  function stopDeferredLoad(): void {
    const current = deferredLoad;
    deferredLoad = undefined;
    current?.cancel();
  }

  function restorePlayback(): void {
    if (
      !document.documentElement?.hasAttribute(blocked) ||
      !queue ||
      !currentPlayer ||
      !stillActive(queue, currentPlayer)
    )
      return;
    const watching = watchId();
    const playing = id(read(invoke(currentPlayer, "getVideoData"), "video_id"));
    if (!playing || (watching && watching !== playing)) return;
    const confirmed = confirmedTracks.get(playing) ?? playerTrack(currentPlayer, playing);
    if (confirmed ?? previous?.id === playing) block(false);
  }

  function deferLoad(
    owner: object,
    player: object,
    target: string,
    load: Load,
  ): boolean {
    if (!load.replay) return false;
    const list = load.list ?? currentList();
    const replay = load.replay;
    const initialUrl = location.href;
    let pausedPrevious = false;
    let committedList: string | undefined;
    const retry = () => resume(false);
    function pauseDisplacedSong(): void {
      if (pausedPrevious || load.list || watchList() || watchId() !== target)
        return;
      const playing = id(read(invoke(player, "getVideoData"), "video_id"));
      if (!playing || playing === target) return;
      pausedPrevious = true;
      invoke(player, "pauseVideo");
    }
    function discard(): void {
      stopDeferredLoad();
      restorePlayback();
    }
    function resume(expired: boolean): void {
      if (deferredLoad?.retry !== retry) return;
      const routeList = watchList();
      const onTarget =
        watchId() === target &&
        (committedList
          ? routeList === committedList
          : !load.list || !routeList || routeList === load.list);
      const opening =
        location.pathname === "/playlist" && !!list && currentList() === list;
      if (
        !stillActive(owner, player) ||
        (!onTarget &&
          !opening &&
          (committedList !== undefined || location.href !== initialUrl))
      ) {
        discard();
        return;
      }
      if (onTarget) {
        committedList ??= routeList;
        pauseDisplacedSong();
        const row = items(owner)[currentIndex(owner)];
        const track = queueTrack(row);
        const rowList = queueList(row);
        const expectedList = load.list ?? routeList;
        if (
          track?.id === target &&
          (!expectedList ||
            rowList === expectedList ||
            (!rowList && routeList === expectedList && list === expectedList)) &&
          (expired ||
            track.allowed !== undefined ||
            confirmedTracks.has(target) ||
            playerTrack(player, target) !== undefined)
        ) {
          stopDeferredLoad();
          replay();
          return;
        }
      }
      if (expired) discard();
    }
    const timeout = setTimeout(() => resume(true), queueTimeout);
    const unsubscribe = invoke(read(owner, "store"), "subscribe", () =>
      queueMicrotask(retry),
    );
    deferredLoad = {
      retry,
      cancel() {
        clearTimeout(timeout);
        if (typeof unsubscribe === "function") {
          try {
            Reflect.apply(unsubscribe, undefined, []);
          } catch {}
        }
      },
    };
    pauseDisplacedSong();
    return true;
  }

  function stopDirectClip(player: object, target: string): boolean {
    if (watchId() !== target || watchList()) return false;
    stopPending();
    block(true);
    invoke(player, "pauseVideo");
    return true;
  }

  function preserveSelection(
    request: Pending,
    store: unknown,
    origin: number,
    fetchAt: number | undefined,
  ): boolean {
    const { queue: owner, player } = request;
    const current = currentIndex(owner);
    const song = request.origin?.id;
    const recover =
      request.recoverClip &&
      song &&
      read(invoke(player, "getVideoData"), "video_id") !== song;
    if (fetchAt === undefined && current === origin && !recover) return true;
    const dispatch = read(store, "dispatch");
    const guards = patched.get(player);
    if (
      typeof dispatch !== "function" ||
      !guards?.has("loadVideoByPlayerVars") ||
      playbackMethods.some((name) => {
        const method = read(player, name);
        return (
          typeof method === "function" && method !== guards.get(name)?.wrapper
        );
      })
    )
      return false;
    const select = (index: number) => {
      Reflect.apply(dispatch, store, [{ type: "SET_INDEX", payload: index }]);
    };
    preservingPlayer = player;
    try {
      try {
        if (fetchAt !== undefined) {
          if (current === fetchAt) select(origin);
          if (!read(owner, "pendingFetchItemsRequest")) select(fetchAt);
        } else if (recover && current === origin) {
          select(request.index);
        }
      } finally {
        if (stillActive(owner, player) && currentIndex(owner) !== origin) {
          if (recover && song) mediaRestore = { request, song };
          select(origin);
        }
      }
      return currentIndex(owner) === origin;
    } catch {
      return false;
    } finally {
      preservingPlayer = undefined;
      mediaRestore = undefined;
    }
  }

  function finishQueueBoundary(request: Pending, rows: unknown[]): void {
    const { queue: owner, origin, list } = request;
    if (
      !origin ||
      !matchesWatch(request) ||
      Math.sign(request.index - origin.index) !== request.step ||
      queueTrack(rows[origin.index])?.id !== origin.id
    ) {
      if (request.refill) stopPending();
      return;
    }
    const store = read(owner, "store");
    const token = id(read(owner, "continuation"));
    const finished =
      completed && completed.list === list && completed.origin === origin.id
        ? completed
        : undefined;
    const shouldFetch =
      request.step === 1 &&
      list !== undefined &&
      infiniteQueue(store) &&
      token !== undefined &&
      !finished?.tokens.has(token) &&
      !request.refill?.tokens.has(token) &&
      !read(owner, "pendingFetchItemsRequest");
    if (
      !preserveSelection(
        request,
        store,
        origin.index,
        shouldFetch ? rows.length - 1 : undefined,
      )
    ) {
      stopPending();
      return;
    }
    const native =
      request.step === 1 ? read(owner, "pendingFetchItemsRequest") : undefined;
    if (typeof read(native, "then") !== "function") {
      stopPending();
      return;
    }
    const refill = (request.refill ??= {
      tokens: new Set(),
      request: undefined,
      timeout: setTimeout(() => {
        if (pending === request) stopPending();
      }, queueTimeout),
    });
    if (refill.request === native) return;
    refill.request = native;
    if (token) refill.tokens.add(token);
    void Promise.resolve(native)
      .then(() => {
        if (pending !== request || refill.request !== native) return;
        if (token && list && matchesWatch(request)) {
          if (completed?.list !== list || completed.origin !== origin.id)
            completed = { list, origin: origin.id, tokens: new Set() };
          completed.tokens.add(token);
        }
        advance(request);
      })
      .catch(() => {
        if (pending === request && refill.request === native) stopPending();
      });
  }

  function advance(request: Pending): void {
    if (pending !== request) return;
    const owner = request.queue;
    if (!stillActive(owner, request.player)) {
      stopPending();
      return;
    }
    const listlessStart = matchesListlessStart(request);
    if (
      !listlessStart &&
      (!request.list || location.href !== request.initialUrl) &&
      stopDirectClip(request.player, request.id)
    )
      return;
    if (!listlessStart && !matchesWatch(request)) {
      stopPending();
      return;
    }
    const rows = items(owner);
    const current = currentIndex(owner);
    const selected = queueTrack(rows[current])?.id;
    const origin = request.refill ? request.origin : undefined;
    const atOrigin = current === origin?.index && selected === origin.id;
    const atRejected = current === request.index && selected === request.id;
    if (request.refill && !atOrigin && !atRejected) {
      stopPending();
      return;
    }
    if (selected !== request.id && selected !== request.previous && !atOrigin)
      return;
    const rejected =
      selected === request.id || atOrigin
        ? current
        : queueTrack(rows[request.index])?.id === request.id
          ? request.index
          : rows.findIndex((item) => queueTrack(item)?.id === request.id);
    if (rejected < 0) {
      if (request.refill) stopPending();
      return;
    }
    const rejectedList = queueList(rows[rejected]);
    if (request.list && rejectedList && request.list !== rejectedList) {
      stopPending();
      return;
    }
    const repeat = repeatAll();
    if (!request.refill && rejected !== request.index) {
      request.index = rejected;
      request.step = skipDirection(
        request.origin?.index,
        rejected,
        rows.length,
        repeat,
      );
    }
    const routeList = watchList();
    for (let count = 1; count < rows.length; count++) {
      const next = rejected + count * request.step;
      if (!repeat && (next < 0 || next >= rows.length)) break;
      const index = (next + rows.length) % rows.length;
      const item = rows[index];
      const candidate = queueTrack(item);
      const candidateList = queueList(item);
      if (
        !candidate ||
        (request.list && candidateList && request.list !== candidateList) ||
        !(
          confirmedTracks.get(candidate.id) ??
          allowsQueueTrack(
            candidate,
            index,
            candidateList ?? routeList,
            request.origin,
          )
        )
      )
        continue;
      const select = read(owner, "selectQueueItem");
      stopPending();
      if (typeof select === "function" && stillActive(owner, request.player))
        Reflect.apply(select, owner, [item]);
      return;
    }
    if (!repeat) finishQueueBoundary(request, rows);
  }

  function allow(
    owner: object,
    player: object,
    target: string,
    method: PlaybackMethod,
    verified?: boolean,
    load?: Load,
  ): boolean {
    const rows = items(owner);
    const current = currentIndex(owner);
    const selected = queueTrack(rows[current]);
    const requestList = load?.list;
    const matchesTarget = (row: unknown) => {
      if (queueTrack(row)?.id !== target) return false;
      const list = queueList(row);
      return (
        !requestList ||
        requestList === list ||
        (!list && watchId() === target && watchList() === requestList)
      );
    };
    const next = matchesTarget(rows[current])
      ? current
      : rows.findIndex(matchesTarget);
    const result = queueTrack(rows[next]);
    const routeList = requestList ?? queueList(rows[next]) ?? watchList();
    const confirmed = verified ?? playerTrack(player, target);
    if (confirmed !== undefined && confirmedTracks.get(target) !== confirmed) {
      confirmedTracks.set(target, confirmed);
      const root = app;
      queueMicrotask(() => {
        if (root?.isConnected && root === app)
          root.querySelectorAll(musicRows).forEach(update);
      });
    }
    const known = confirmedTracks.get(target) ?? result?.allowed;
    const allowed = known ?? allowsQueueTrack(result, next, routeList, previous);
    if (
      method === "enqueueVideoByPlayerVars" ||
      method === "cueVideoByPlayerVars"
    )
      return allowed;
    if (allowed) {
      block(false);
      const active = pending;
      if (
        method === "playVideo" &&
        active?.origin?.id === target &&
        (current === active.origin.index || current === active.index) &&
        matchesWatch(active)
      )
        return true;
      stopPending();
      if (previous?.list !== routeList) prior = undefined;
      else if (previous?.id !== target) prior = previous;
      previous = {
        id: target,
        index: next,
        item: rows[next],
        ...(routeList ? { list: routeList } : {}),
      };
      return true;
    }
    if (known === false && !requestList && stopDirectClip(player, target))
      return false;
    if (
      load?.replay &&
      (next < 0 || known === undefined) &&
      deferLoad(owner, player, target, load)
    ) {
      stopPending();
      if (!previous || previous.id === target || watchId() === target)
        block(true);
      return false;
    }
    if (!requestList && stopDirectClip(player, target)) return false;
    if (confirmedTracks.get(target) === false && previous?.id === target) {
      previous =
        prior && confirmedTracks.get(prior.id) !== false ? prior : undefined;
      prior = undefined;
    }
    const list = routeList ?? previous?.list;
    const retained = previous ? rows.indexOf(previous.item) : -1;
    if (
      previous &&
      list &&
      previous.list !== list &&
      (previous.list || retained < 0)
    ) {
      previous = undefined;
      prior = undefined;
    }
    if (!previous || previous.id === target) block(true);
    const old =
      previous &&
      (retained >= 0
        ? retained
        : queueTrack(rows[previous.index])?.id === previous.id
          ? previous.index
          : -1);
    if (previous && old !== undefined && old >= 0 && old !== previous.index)
      previous = { ...previous, index: old };
    if (next < 0) {
      stopPending();
      return false;
    }
    const step = skipDirection(old, next, rows.length, repeatAll());
    const recoverClip =
      verified === false || (confirmed === false && method === "playVideo");
    const active = pending;
    if (
      active?.refill &&
      active.queue === owner &&
      active.player === player &&
      active.id === target &&
      active.index === next &&
      active.step === step &&
      active.list === list &&
      active.origin === previous
    ) {
      if (recoverClip) active.recoverClip = true;
      queueMicrotask(() => advance(active));
      return false;
    }
    stopPending();
    const request: Pending = {
      queue: owner,
      player,
      id: target,
      index: next,
      ...(selected ? { previous: selected.id } : {}),
      ...(previous ? { origin: previous } : {}),
      ...(list ? { list } : {}),
      ...(requestList ? { requestedList: requestList } : {}),
      initialUrl: location.href,
      ...(recoverClip ? { recoverClip: true } : {}),
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
    for (const name of playbackMethods) {
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
      const entry: Guard = { owner, original: undefined, wrapper: undefined };
      function wrap(value: unknown): unknown {
        entry.original = value;
        if (typeof value !== "function") return value;
        return new Proxy(value, {
          apply(method, receiver: unknown, args: unknown[]) {
            const owner = entry.owner;
            if (stillActive(owner, player)) {
              const playing =
                name === "playVideo" ? playbackVideo(player) : undefined;
              if (playing === null) return;
              const target =
                name === "playVideo"
                  ? (playing ??
                    queueTrack(items(owner)[currentIndex(owner)])?.id ??
                    watchId())
                  : videoArgument(args[0]);
              if (preservingPlayer === player) {
                const restore = mediaRestore;
                if (
                  name !== "loadVideoByPlayerVars" ||
                  !restore ||
                  target !== restore.song
                )
                  return;
                mediaRestore = undefined;
                const result: unknown = Reflect.apply(method, receiver, args);
                restore.request.recoverClip = false;
                block(false);
                return result;
              }
              if (name === "loadVideoByPlayerVars") {
                stopDeferredLoad();
                if (target) {
                  const suppliedList = playlistArgument(args[0]);
                  const list = suppliedList ??
                    (location.pathname === "/playlist" ? currentList() : undefined);
                  const replay = () => {
                    if (
                      videoArgument(args[0]) !== target ||
                      playlistArgument(args[0]) !== suppliedList
                    )
                      return;
                    guard(owner, player);
                    const current = patched.get(player)?.get(name);
                    const original = current?.original;
                    if (
                      typeof original === "function" &&
                      read(player, name) === current?.wrapper &&
                      allow(owner, player, target, name, undefined, { list })
                    )
                      Reflect.apply(original, receiver, args);
                  };
                  if (
                    !allow(owner, player, target, name, undefined, { list, replay })
                  )
                    return;
                }
              } else if (target && !allow(owner, player, target, name)) return;
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
      prior = undefined;
      completed = undefined;
      stopPending();
      stopDeferredLoad();
    }
    if (owner && player) guard(owner, player);
    deferredLoad?.retry();
    restorePlayback();
  }

  function update(row: Element): void {
    const candidate = track(read(row, "data"));
    row.toggleAttribute(
      filtered,
      candidate !== undefined &&
        !(confirmedTracks.get(candidate.id) ?? candidate.allowed),
    );
  }

  function collect(node: Node, changed: Set<Element>): void {
    if (!(node instanceof Element)) return;
    if (node.matches(musicRows)) changed.add(node);
    for (const row of node.querySelectorAll(musicRows)) changed.add(row);
  }

  const observer = new MutationObserver((records) => {
    if (!app?.isConnected) return;
    updateQueue();
    syncLyrics(app);
    if (records.some(libraryMutation)) syncLibrary(app);
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
    const root = document.querySelector(appSelector);
    if (root !== app) {
      appLifetime?.abort();
      appLifetime = undefined;
      confirmedTracks.clear();
      stopDeferredLoad();
    }
    app = root;
    observer.disconnect();
    observeAppTree(lifecycle, app);
    updateQueue();
    syncLyrics(app);
    if (!app) {
      syncLibrary(null);
      return;
    }
    if (!appLifetime) {
      appLifetime = new AbortController();
      navigation(() => {
        if (
          pending &&
          !matchesWatch(pending) &&
          !matchesListlessStart(pending) &&
          !stopDirectClip(pending.player, pending.id)
        )
          stopPending();
        deferredLoad?.retry();
        restorePlayback();
      }, appLifetime.signal);
    }
    observer.observe(app, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    syncLibrary(app);
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
      const playing = playbackVideo(player);
      if (playing === null) {
        video.pause();
        return;
      }
      const target = playing ?? watchId();
      if (!target) return;
      const verified = playerTrack(player, target);
      const allowed = queue
        ? allow(queue, currentPlayer ?? player, target, "playVideo", verified)
        : (verified ?? false);
      block(!allowed);
      if (!allowed) video.pause();
    },
    true,
  );
}
