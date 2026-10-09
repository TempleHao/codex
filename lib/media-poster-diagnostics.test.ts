import { expect, it } from "vitest";
import { mediaPosterDiagnostics, mediaPosterRecordDiagnostics } from "./media-poster-diagnostics";

it("reports missing addresses separately from failed images and excludes private fields", () => {
  const report = mediaPosterDiagnostics([
    { id: "private-id", traktId: 1, kind: "movie", title: "私密片名", thought: "私密感想", status: "watched", genres: [], history: [], poster: "https://walter-r2.trakt.tv/images/movies/1/posters/a.jpg.webp" },
    { id: "another-id", traktId: 2, kind: "show", title: "另一个片名", status: "wanted", genres: [], history: [] },
  ], ["loaded", "loading", "decode-failed", "cache-unavailable"], { secure: true, serviceWorker: true, controlled: true, cacheStorage: true, indexedDB: true }, null);
  expect(report.counts).toEqual({ works: 2, withAddress: 1, withoutAddress: 1, missingTraktAddress: 1, displayed: 1, waiting: 1, responseFailed: 1, cacheUnavailable: 1 });
  const text = JSON.stringify(report);
  for (const privateValue of ["私密", "private-id", "another-id", "http", "walter", "poster"]) expect(text).not.toContain(privateValue);
});

it("copies only public work identifiers while distinguishing a missing address from decode failure", () => {
  const entry = { id: "private-local-id", kind: "show" as const, title: "私人片名", thought: "私人感想", genres: [], status: "unclassified" as const, history: [{ id: "private-view-id", watchedAt: "2026-10-09" }], traktId: 123, year: 2020, traktUrl: "https://trakt.tv/shows/public-show-2020", accessToken: "never-copy-this-token" };
  const missing = mediaPosterRecordDiagnostics(entry, "missing");
  expect(missing).toMatchObject({ traktId: 123, imdbId: null, hasPosterAddress: false, state: "missing" });
  const failed = mediaPosterRecordDiagnostics({ ...entry, imdbId: "tt1375666", poster: "https://images.metahub.space/poster/medium/tt1375666/img" }, "decode-failed");
  expect(failed).toMatchObject({ imdbId: "tt1375666", hasPosterAddress: true, posterHost: "images.metahub.space", state: "decode-failed" });
  for (const value of [entry.id, entry.title, entry.thought, entry.history[0].id, entry.history[0].watchedAt, entry.accessToken]) expect(JSON.stringify([missing, failed])).not.toContain(value);
  expect(mediaPosterRecordDiagnostics({ ...entry, traktUrl: "https://trakt.tv/shows/x?token=secret" }, "secret")).toMatchObject({ traktUrl: null, state: "unknown" });
});
