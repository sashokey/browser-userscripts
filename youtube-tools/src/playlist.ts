import { app, mobile, navigation, ready } from "./dom.ts";

const flag = "canAutoAdvance_";

type Suppression = { maintain(): boolean; restore?(): void };

function playlistWatch(): boolean {
  return (
    location.pathname === "/watch" &&
    Boolean(new URLSearchParams(location.search).get("list"))
  );
}

function attempt<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

function read(owner: object, key: string): unknown {
  return attempt<unknown>(() => Reflect.get(owner, key));
}

function inheritedProperty(
  owner: object,
  key: string,
): PropertyDescriptor | undefined {
  return attempt(() => {
    for (
      let prototype = Reflect.getPrototypeOf(owner);
      prototype;
      prototype = Reflect.getPrototypeOf(prototype)
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor) return descriptor;
    }
  });
}

function writeOwn(receiver: object, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(receiver, key);
  if (!own)
    Reflect.defineProperty(receiver, key, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  else if (own.writable) Reflect.defineProperty(receiver, key, { value });
}

function seekingAudioEnd(media: HTMLVideoElement): boolean {
  const remaining = media.duration - media.currentTime;
  return (
    media.seeking &&
    !media.paused &&
    !media.ended &&
    media.videoWidth === 0 &&
    media.currentTime > 1 &&
    remaining >= 0 &&
    remaining < 1
  );
}

function recoverTerminalAudioSeek(): void {
  const attempted = new WeakMap<HTMLVideoElement, string>();
  let pending: number | undefined;
  function reset(event: Event): void {
    const media = event.target;
    if (media instanceof HTMLVideoElement && !media.seeking)
      attempted.delete(media);
  }
  document.addEventListener("seeked", reset, true);
  document.addEventListener("emptied", reset, true);
  document.addEventListener(
    "seeking",
    (event) => {
      const media = event.target;
      if (!(media instanceof HTMLVideoElement)) return;
      const player = media.closest("#movie_player");
      if (!player || player.querySelector("video") !== media) return;
      if (pending !== undefined) {
        window.clearTimeout(pending);
        pending = undefined;
      }
      if (
        !playlistWatch() ||
        !seekingAudioEnd(media) ||
        player.classList.contains("ad-showing")
      )
        return;
      const url = location.href;
      if (attempted.get(media) === url) return;
      const time = media.currentTime;
      pending = window.setTimeout(() => {
        pending = undefined;
        if (
          url !== location.href ||
          !media.isConnected ||
          player.querySelector("video") !== media ||
          player.classList.contains("ad-showing") ||
          media.currentTime !== time ||
          media.readyState >= media.HAVE_CURRENT_DATA ||
          !seekingAudioEnd(media)
        )
          return;
        const state = read(player, "getPlayerState");
        const seek = read(player, "seekTo");
        if (typeof state !== "function" || typeof seek !== "function") return;
        attempt(() => {
          if (Reflect.apply(state, player, []) !== 0) return;
          attempted.set(media, url);
          try {
            Reflect.apply(seek, player, [time - 1, true]);
          } catch {
            attempted.delete(media);
          }
        });
      }, 250);
    },
    true,
  );
}

function preventAdvance(owner: unknown): Suppression | undefined {
  if (!owner || typeof owner !== "object") return;
  const initial = read(owner, flag);
  if (typeof initial !== "boolean") return;
  const original = attempt(() => Object.getOwnPropertyDescriptor(owner, flag));
  const inherited = original ? undefined : inheritedProperty(owner, flag);
  if ((original?.configurable && original.writable) || inherited?.writable) {
    let value: unknown = initial;
    let written = false;
    const get = function (this: unknown): unknown {
      if (playlistWatch()) return false;
      if (original || written) return value;
      const prototype = Reflect.getPrototypeOf(owner);
      return prototype ? Reflect.get(prototype, flag, this) : undefined;
    };
    const installed = attempt(() =>
      Reflect.defineProperty(owner, flag, {
        configurable: true,
        enumerable: original?.enumerable ?? false,
        get,
        set(this: object, next: unknown) {
          if (this === owner) {
            value = next;
            written = true;
            return;
          }
          writeOwn(this, flag, next);
        },
      }),
    );
    if (installed) {
      const maintain = () =>
        attempt(() => Object.getOwnPropertyDescriptor(owner, flag))?.get ===
        get;
      return {
        maintain,
        restore() {
          if (!maintain()) return;
          if (original)
            Reflect.defineProperty(owner, flag, { ...original, value });
          else if (written)
            Reflect.defineProperty(owner, flag, {
              value,
              configurable: true,
              enumerable: true,
              writable: true,
            });
          else Reflect.deleteProperty(owner, flag);
        },
      };
    }
  }

  let suppressed = false;
  let writing = false;
  let observedSetter: ((this: unknown, next: unknown) => void) | undefined;
  function ownsSetter(): boolean {
    return (
      !observedSetter ||
      attempt(() => Object.getOwnPropertyDescriptor(owner, flag))?.set ===
        observedSetter
    );
  }
  const maintain = (): boolean => {
    if (!ownsSetter()) return false;
    const value = read(owner, flag);
    if (value === false) return true;
    if (value !== true) return false;
    writing = true;
    const written = attempt(() => Reflect.set(owner, flag, false));
    writing = false;
    if (written !== true) return false;
    suppressed = true;
    return read(owner, flag) !== true;
  };
  if (!maintain()) return;
  const accessor = original
    ? original.configurable
      ? original
      : undefined
    : inherited;
  const setter: unknown = accessor ? Reflect.get(accessor, "set") : undefined;
  if (accessor && typeof setter === "function") {
    const update = function (this: unknown, next: unknown): void {
      Reflect.apply(setter, this, [next]);
      if (this === owner && !writing && next === false) suppressed = false;
    };
    if (
      attempt(() =>
        Reflect.defineProperty(owner, flag, {
          ...accessor,
          configurable: true,
          enumerable: original?.enumerable ?? false,
          set: update,
        }),
      )
    )
      observedSetter = update;
  }
  return {
    maintain,
    restore() {
      if (!ownsSetter()) return;
      if (observedSetter) {
        if (original) Reflect.defineProperty(owner, flag, original);
        else Reflect.deleteProperty(owner, flag);
      }
      if (!suppressed || read(owner, flag) !== false) return;
      if (
        !original &&
        Object.getOwnPropertyDescriptor(owner, flag)?.value === false
      )
        Reflect.deleteProperty(owner, flag);
      else Reflect.set(owner, flag, true);
    },
  };
}

function preventNativeAdvance(manager: Element): Suppression | undefined {
  const native = read(manager, "TEST_ONLY");
  if (!native || typeof native !== "object") return;
  const method = "setCanAutoAdvance";
  const setter = read(native, method);
  if (typeof setter !== "function") return;
  const getter = read(native, "getCanAutoAdvance");
  const readNativeState =
    typeof getter === "function"
      ? () => attempt<unknown>(() => Reflect.apply(getter, native, []))
      : undefined;
  const readManagerState = () => read(manager, flag);
  let raw: unknown = setter;
  let exposed: unknown = setter;
  let observed = false;
  let assigned = false;
  const get = () => exposed;
  const ownsMethod = (): boolean =>
    observed
      ? attempt(() => Object.getOwnPropertyDescriptor(native, method))?.get ===
          get
      : read(native, method) === setter;
  const write = (value: boolean) =>
    attempt(() => {
      const writer = observed && ownsMethod() ? raw : read(native, method);
      if (typeof writer !== "function") return false;
      Reflect.apply(writer, native, [value]);
      return true;
    }) === true;
  let applied = false;
  let readSuppressedState: (() => unknown) | undefined;

  function suppress(): boolean {
    const nativeState = readNativeState?.();
    const readState =
      typeof nativeState === "boolean" && readNativeState
        ? readNativeState
        : readManagerState;
    const previous =
      typeof nativeState === "boolean" ? nativeState : readManagerState();
    if (applied && previous === false) return true;
    if (typeof previous !== "boolean" || !write(false)) return false;
    if (previous) readSuppressedState = readState;
    applied = true;
    return readState() !== true;
  }

  if (!suppress()) return;
  const original = attempt(() =>
    Object.getOwnPropertyDescriptor(native, method),
  );
  if (
    original
      ? original.configurable && original.writable
      : inheritedProperty(native, method)?.writable
  ) {
    function wrap(candidate: unknown): unknown {
      if (typeof candidate !== "function") return candidate;
      return new Proxy(candidate, {
        apply(target, receiver: unknown, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (receiver === native && args[0] === false)
            readSuppressedState = undefined;
          return result;
        },
      });
    }
    exposed = wrap(setter);
    observed =
      attempt(() =>
        Reflect.defineProperty(native, method, {
          configurable: true,
          enumerable: original?.enumerable ?? false,
          get,
          set(this: object, next: unknown) {
            if (this !== native) {
              writeOwn(this, method, next);
              return;
            }
            if (next === exposed) return;
            assigned = true;
            raw = next;
            exposed = wrap(next);
          },
        }),
      ) === true;
  }
  return {
    maintain() {
      return (
        read(manager, "TEST_ONLY") === native && ownsMethod() && suppress()
      );
    },
    restore() {
      if (observed && ownsMethod()) {
        if (original)
          Reflect.defineProperty(native, method, { ...original, value: raw });
        else {
          Reflect.deleteProperty(native, method);
          if (assigned) writeOwn(native, method, raw);
        }
      }
      if (readSuppressedState?.() === false) write(true);
    },
  };
}

function desktop(root: Element, signal: AbortSignal): void {
  let manager: Element | null = null;
  let controller: unknown;
  let suppression: Suppression | undefined;
  let watching = false;
  const observer = new MutationObserver((records) => {
    if (
      !suppression ||
      records.some(({ addedNodes, removedNodes }) =>
        [...addedNodes, ...removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches("yt-playlist-manager") ||
              Boolean(node.querySelector("yt-playlist-manager"))),
        ),
      )
    )
      check();
  });

  function restore(): void {
    const previous = suppression;
    suppression = undefined;
    attempt(() => previous?.restore?.());
  }

  function check(): void {
    if (signal.aborted) return;
    if (!playlistWatch()) {
      observer.disconnect();
      watching = false;
      restore();
      manager = null;
      controller = undefined;
      return;
    }
    if (!watching) {
      observer.observe(root, { subtree: true, childList: true });
      watching = true;
    }
    const nextManager =
      root.querySelector("yt-playlist-manager") ??
      document.querySelector("yt-playlist-manager");
    const nextController = nextManager
      ? read(nextManager, "polymerController")
      : undefined;
    if (
      nextManager === manager &&
      nextController === controller &&
      suppression?.maintain()
    )
      return;
    restore();
    manager = nextManager;
    controller = nextController;
    if (manager)
      suppression =
        preventAdvance(controller) ??
        preventNativeAdvance(manager) ??
        preventAdvance(manager);
  }

  navigation(check, signal);
  document.addEventListener("ended", check, { capture: true, signal });
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      restore();
    },
    { once: true },
  );
  void customElements.whenDefined("yt-playlist-manager").then(check);
  check();
}

export function playlist(): void {
  recoverTerminalAudioSeek();
  if (!mobile) {
    ready(() => app(desktop));
    return;
  }
  window.addEventListener(
    "player-state-change",
    (event) => {
      const detail: unknown = "detail" in event ? event.detail : undefined;
      if (
        detail &&
        typeof detail === "object" &&
        "state" in detail &&
        detail.state === 0 &&
        playlistWatch()
      )
        event.stopImmediatePropagation();
    },
    true,
  );
}
