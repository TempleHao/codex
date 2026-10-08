import type { MediaEntry } from "./media";
import type { TraktArtworkProgress } from "./trakt";

export interface PosterPlatform {
  secure: boolean;
  serviceWorker: boolean;
  controlled: boolean;
  cacheStorage: boolean;
  indexedDB: boolean;
}

/** No title, identifier, image URL, account data or credential enters this report. */
export function mediaPosterDiagnostics(entries: readonly MediaEntry[], states: readonly string[], platform: PosterPlatform, artwork: TraktArtworkProgress | null) {
  const count = (state: string) => states.filter(value => value === state).length;
  return {
    version: 1,
    counts: {
      works: entries.length,
      withAddress: entries.filter(entry => entry.poster).length,
      withoutAddress: entries.filter(entry => !entry.poster).length,
      missingTraktAddress: entries.filter(entry => entry.traktId && entry.kind !== "episode" && !entry.poster).length,
      displayed: count("loaded"),
      waiting: count("loading"),
      cacheUnavailable: count("cache-unavailable"),
      responseFailed: count("decode-failed"),
    },
    platform: { secure: platform.secure, serviceWorker: platform.serviceWorker, controlled: platform.controlled, cacheStorage: platform.cacheStorage, indexedDB: platform.indexedDB },
    artwork: artwork ? { checked: artwork.checked, found: artwork.found, missing: artwork.missing, failed: artwork.failed, deferred: artwork.deferred, rejected: artwork.rejected } : null,
  };
}
export type MediaPosterDiagnostics = ReturnType<typeof mediaPosterDiagnostics>;
