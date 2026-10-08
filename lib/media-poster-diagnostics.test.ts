import { expect, it } from "vitest";
import { mediaPosterDiagnostics } from "./media-poster-diagnostics";

it("reports missing addresses separately from failed images and excludes private fields", () => {
  const report = mediaPosterDiagnostics([
    { id: "private-id", traktId: 1, kind: "movie", title: "私密片名", thought: "私密感想", status: "watched", genres: [], history: [], poster: "https://walter-r2.trakt.tv/images/movies/1/posters/a.jpg.webp" },
    { id: "another-id", traktId: 2, kind: "show", title: "另一个片名", status: "wanted", genres: [], history: [] },
  ], ["loaded", "loading", "decode-failed", "cache-unavailable"], { secure: true, serviceWorker: true, controlled: true, cacheStorage: true, indexedDB: true }, null);
  expect(report.counts).toEqual({ works: 2, withAddress: 1, withoutAddress: 1, missingTraktAddress: 1, displayed: 1, waiting: 1, responseFailed: 1, cacheUnavailable: 1 });
  const text = JSON.stringify(report);
  for (const privateValue of ["私密", "private-id", "another-id", "http", "walter", "poster"]) expect(text).not.toContain(privateValue);
});
