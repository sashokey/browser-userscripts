import assert from "node:assert/strict";

export function musicRows(selectors: string): {
  visibleTracks: number;
  visibleClips: number;
  classified: number;
} {
  function field(value: unknown, key: string): unknown {
    return value && typeof value === "object"
      ? Reflect.get(value, key)
      : undefined;
  }

  function path(value: unknown, ...keys: string[]): unknown {
    return keys.reduce<unknown>(field, value);
  }

  let visibleTracks = 0;
  let visibleClips = 0;
  let classified = 0;
  for (const row of document.querySelectorAll(selectors)) {
    const data = field(row, "data");
    const endpoint =
      field(data, "navigationEndpoint") ??
      field(data, "onTap") ??
      path(
        data,
        "flexColumns",
        "0",
        "musicResponsiveListItemFlexColumnRenderer",
        "text",
        "runs",
        "0",
        "navigationEndpoint",
      );
    const kind = path(
      endpoint,
      "watchEndpoint",
      "watchEndpointMusicSupportedConfigs",
      "watchEndpointMusicConfig",
      "musicVideoType",
    );
    if (typeof kind !== "string") continue;
    classified++;
    if (
      !row.getClientRects().length ||
      getComputedStyle(row).visibility === "hidden"
    )
      continue;
    if (kind === "MUSIC_VIDEO_TYPE_ATV") visibleTracks++;
    else visibleClips++;
  }
  return { visibleTracks, visibleClips, classified };
}

export function onlyTracks(observed: ReturnType<typeof musicRows>): void {
  assert.ok(
    observed.visibleTracks > 0,
    "The real surface shows an audio track",
  );
  assert.equal(
    observed.visibleClips,
    0,
    "The real surface shows a YouTube video",
  );
}

export function playbackType(): {
  id: unknown;
  kind: unknown;
  playing: boolean;
} {
  const player = document.querySelector("#movie_player");
  const video = player?.querySelector("video");
  const read: unknown = player && Reflect.get(player, "getPlayerResponse");
  const response: unknown =
    typeof read === "function" ? Reflect.apply(read, player, []) : undefined;
  const details: unknown =
    response &&
    typeof response === "object" &&
    Reflect.get(response, "videoDetails");
  const readNative: unknown = player && Reflect.get(player, "getVideoData");
  const native: unknown =
    typeof readNative === "function"
      ? Reflect.apply(readNative, player, [])
      : undefined;
  const id: unknown =
    details && typeof details === "object"
      ? Reflect.get(details, "videoId")
      : undefined;
  const nativeId: unknown =
    native && typeof native === "object"
      ? Reflect.get(native, "video_id")
      : undefined;
  return {
    id,
    kind:
      details && typeof details === "object"
        ? Reflect.get(details, "musicVideoType")
        : undefined,
    playing:
      typeof id === "string" &&
      id === nativeId &&
      !!video &&
      !player?.classList.contains("ad-showing") &&
      !video.paused &&
      !video.ended &&
      video.currentTime > 0,
  };
}

export function audioTrackStarted(
  actual: ReturnType<typeof playbackType>,
): void {
  assert.equal(actual.playing, true, "The real player started playback");
  assert.equal(
    actual.kind,
    "MUSIC_VIDEO_TYPE_ATV",
    "The real player started a YouTube video",
  );
}

export function nativeNextContinues(
  previous: ReturnType<typeof playbackType>,
  next: ReturnType<typeof playbackType>,
): void {
  audioTrackStarted(next);
  assert.notEqual(next.id, previous.id, "Next must start a different track");
}

export function directClipIsBlocked(
  actual: ReturnType<typeof playbackType>,
  clipId: string,
): void {
  assert.ok(
    !actual.playing || actual.id !== clipId,
    "The real player started the directly opened video",
  );
}
