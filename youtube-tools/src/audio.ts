import { enabled } from "./state.ts";

const objectConstructorSource = Function.prototype.toString.call(Object);
const maxAudioPreloads = 256;
const accessorValue = Symbol();

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): value is object {
  return !!value && (typeof value === "object" || typeof value === "function");
}

function dataValue(source: object, key: string): unknown {
  for (
    let owner: object | null = source;
    owner;
    owner = Reflect.getPrototypeOf(owner)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) {
      if (!("value" in descriptor)) return accessorValue;
      const value: unknown = descriptor.value;
      return value;
    }
  }
}

function withProperty(
  source: object,
  key: "args" | "audio_only",
  value: unknown,
): object | undefined {
  const prototype = Reflect.getPrototypeOf(source);
  const constructor =
    prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (constructor) {
    const nativeConstructor: unknown = constructor.value;
    if (
      typeof nativeConstructor !== "function" ||
      Function.prototype.toString.call(nativeConstructor) !==
        objectConstructorSource
    )
      return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  const extensible = Object.isExtensible(source);
  if (
    descriptor ? !descriptor.writable : !extensible || Reflect.has(source, key)
  )
    return;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  descriptors[key] = descriptor
    ? { ...descriptor, value }
    : { configurable: true, enumerable: true, writable: true, value };
  const copy = Object.defineProperties({}, descriptors);
  Object.setPrototypeOf(copy, prototype);
  return extensible ? copy : Object.preventExtensions(copy);
}

type Callable = (this: unknown, ...args: unknown[]) => unknown;
type Preloads = {
  injected: Set<string>;
  native: Set<string>;
  injectedOverflow: boolean;
  nativeOverflow: boolean;
};

function callable(value: unknown): value is Callable {
  return typeof value === "function";
}

export function audio(): void {
  const patches = new WeakMap<object, Map<string, () => unknown>>();
  const wrappers = new WeakSet<object>();
  const audioPreloads = new WeakMap<object, Preloads>();

  function rememberPreload(
    owner: object,
    id: string | undefined,
    native: boolean,
  ): void {
    let preloads = audioPreloads.get(owner);
    if (!preloads) {
      preloads = {
        injected: new Set(),
        native: new Set(),
        injectedOverflow: false,
        nativeOverflow: false,
      };
      audioPreloads.set(owner, preloads);
    }
    if (id === undefined) {
      preloads.nativeOverflow = true;
    } else if (native) {
      preloads.injected.delete(id);
      if (preloads.native.size < maxAudioPreloads) preloads.native.add(id);
      else if (!preloads.native.has(id)) preloads.nativeOverflow = true;
    } else if (!preloads.native.has(id) && !preloads.nativeOverflow) {
      if (preloads.injected.size < maxAudioPreloads) preloads.injected.add(id);
      else if (!preloads.injected.has(id)) preloads.injectedOverflow = true;
    }
  }

  function intercept(
    owner: unknown,
    key: string,
    transform: (value: unknown) => unknown,
  ): void {
    if (!object(owner)) return;
    const previous = patches.get(owner);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      const installed = previous?.get(key);
      if (installed && descriptor?.get === installed) return;
      if (
        descriptor &&
        (!descriptor.configurable ||
          !("value" in descriptor) ||
          descriptor.writable === false)
      )
        return;
      let inherited: PropertyDescriptor | undefined;
      if (!descriptor && Reflect.has(owner, key)) {
        const visited = new Set([owner]);
        let prototype = Reflect.getPrototypeOf(owner);
        while (prototype && !inherited) {
          if (visited.has(prototype)) return;
          visited.add(prototype);
          inherited = Object.getOwnPropertyDescriptor(prototype, key);
          if (!inherited) prototype = Reflect.getPrototypeOf(prototype);
        }
        if (!inherited?.writable) return;
      }
      let followsPrototype = inherited !== undefined;
      let original: unknown = Reflect.get(owner, key);
      let value: unknown = transform(original);
      const get = function (this: unknown): unknown {
        if (followsPrototype) {
          const prototype = Reflect.getPrototypeOf(owner);
          const implementation: unknown = prototype
            ? Reflect.get(prototype, key, this)
            : undefined;
          if (!Object.is(implementation, original)) {
            value = transform(implementation);
            original = implementation;
          }
        }
        return value;
      };
      Object.defineProperty(owner, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? inherited?.enumerable ?? true,
        get,
        set(this: object, next: unknown) {
          if (this === owner) {
            value = transform(next);
            followsPrototype = false;
            return;
          }
          const own = Object.getOwnPropertyDescriptor(this, key);
          if (!own) {
            Object.defineProperty(this, key, {
              value: next,
              configurable: true,
              enumerable: true,
              writable: true,
            });
          } else if (own.writable) {
            Object.defineProperty(this, key, { value: next });
          }
        },
      });
      const keys = previous ?? new Map<string, () => unknown>();
      keys.set(key, get);
      patches.set(owner, keys);
    } catch {}
  }

  function wrap(
    value: unknown,
    apply: (
      target: Callable,
      receiver: unknown,
      argumentsList: unknown[],
    ) => unknown,
  ): unknown {
    if (!callable(value) || wrappers.has(value)) return value;
    const wrapped = new Proxy(value, { apply });
    wrappers.add(wrapped);
    return wrapped;
  }

  function transport(player: unknown): void {
    for (const method of [
      "loadVideoByPlayerVars",
      "cueVideoByPlayerVars",
      "preloadVideoByPlayerVars",
    ] as const) {
      intercept(player, method, (original) =>
        wrap(original, (target, receiver, args) => {
          const owner = object(receiver) ? receiver : undefined;
          const preloads = owner && audioPreloads.get(owner);
          const preload = method === "preloadVideoByPlayerVars";
          const current = enabled("audioOnly");
          let videoId: string | undefined;
          let opaqueId = false;
          let parameters = args;
          let preserveNative = false;
          if (current || preloads || preload) {
            try {
              const params = args[0];
              if (record(params)) {
                const mode = dataValue(params, "audio_only");
                preserveNative = mode === true || mode === accessorValue;
                if (preload || preloads) {
                  const nativeId = dataValue(params, "video_id");
                  const id =
                    typeof nativeId === "string" || nativeId === accessorValue
                      ? nativeId
                      : dataValue(params, "videoId");
                  if (typeof id === "string") videoId = id;
                  opaqueId = id === accessorValue;
                }
                if (
                  current
                    ? !preserveNative
                    : !preload &&
                      videoId &&
                      preloads &&
                      (mode === undefined || mode === null) &&
                      !preloads.native.has(videoId) &&
                      (preloads.injected.has(videoId) ||
                        (preloads.injectedOverflow && !preloads.nativeOverflow))
                ) {
                  const updated = withProperty(params, "audio_only", current);
                  if (updated) parameters = [updated, ...args.slice(1)];
                }
              }
            } catch {}
          }
          const result: unknown = Reflect.apply(target, receiver, parameters);
          if (
            owner &&
            preload &&
            (videoId !== undefined || opaqueId) &&
            (preserveNative || parameters !== args)
          )
            rememberPreload(owner, videoId, preserveNative);
          return result;
        }),
      );
    }
  }

  intercept(unsafeWindow, "yt", (yt) => {
    intercept(yt, "player", (player) => {
      intercept(player, "Application", (application) => {
        for (const method of ["create", "createAlternate"]) {
          intercept(application, method, (original) =>
            wrap(original, (target, receiver, args) => {
              const config = args[1];
              let parameters = args;
              if (enabled("audioOnly")) {
                try {
                  if (record(config)) {
                    const supplied: unknown = Object.getOwnPropertyDescriptor(
                      config,
                      "args",
                    )?.value;
                    if (record(supplied)) {
                      const payload = withProperty(
                        supplied,
                        "audio_only",
                        true,
                      );
                      const updated =
                        payload && withProperty(config, "args", payload);
                      if (updated)
                        parameters = [args[0], updated, ...args.slice(2)];
                    }
                  }
                } catch {}
              }
              const result: unknown = Reflect.apply(
                target,
                receiver,
                parameters,
              );
              transport(result);
              return result;
            }),
          );
        }
        return application;
      });
      return player;
    });
    return yt;
  });
}
