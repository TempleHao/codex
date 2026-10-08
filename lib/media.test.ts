import { describe, expect, it } from "vitest";
import { emptyMediaLibrary, mediaEntrySchema, mediaLibrarySchema, mergeMediaLibraries, parseMediaImport, traktMediaId } from "./media";
import type { MediaEntry, MediaLibrary } from "./media";

const movie = (overrides: Partial<MediaEntry> = {}): MediaEntry => ({
  id: "manual-movie", kind: "movie", title: "示例电影", genres: ["剧情"], status: "wanted", history: [], ...overrides,
});
const show = (overrides: Partial<MediaEntry> = {}): MediaEntry => ({
  id: "manual-show", kind: "show", title: "示例剧集", genres: [], status: "watching", history: [], ...overrides,
});
const episode = (overrides: Partial<MediaEntry> = {}): MediaEntry => ({
  id: "manual-episode", kind: "episode", title: "第一集", genres: [], status: "watched", history: [],
  showId: "manual-show", season: 1, episode: 1, ...overrides,
});
const library = (entries: MediaEntry[] = [movie()], overrides: Partial<MediaLibrary> = {}): MediaLibrary => ({
  ...emptyMediaLibrary(), entries, ...overrides,
});
const watched = (id: string, watchedAt = "2026-10-07T12:00:00+08:00") => ({ id, watchedAt });

describe("portable media imports", () => {
  it("starts with an independent empty manual library", () => {
    const first = emptyMediaLibrary();
    expect(first).toEqual({ version: 1, source: "manual", syncedAt: null, entries: [] });
    first.entries.push(movie());
    expect(emptyMediaLibrary().entries).toEqual([]);
  });

  it("round-trips the complete library with original thoughts and real watch events", () => {
    const thought = "  这段原文要保留空格。\n第二行与 \"引用\"。  ";
    const data = library([
      movie({ status: "watched", rating: 8.5, thought, history: [watched("watch-1", "2024-02-29"), watched("watch-2")] }),
      show(), episode({ history: [watched("watch-3")] }),
    ], { source: "trakt", syncedAt: "2026-10-07T10:00:00Z" });
    expect(parseMediaImport(data)).toEqual(data);
    expect(parseMediaImport(JSON.stringify(data))).toEqual(data);
  });

  it("never invents watch history from a watched status or a summary count", () => {
    const data = library([movie({ status: "watched" })]);
    expect(parseMediaImport(data).entries[0].history).toEqual([]);
    for (const input of [
      { ...data, stats: { watched: 800 } },
      { ...data, entries: [{ ...data.entries[0], plays: 800 }] },
      { movies: { watched: 800 }, shows: { watched: 20 } },
    ]) expect(() => parseMediaImport(input)).toThrow();
  });

  it("requires the full versioned shape and rejects unrelated fields", () => {
    for (const input of [
      {}, { version: 2, source: "manual", syncedAt: null, entries: [] },
      { version: 1, source: "unknown", syncedAt: null, entries: [] },
      { version: 1, source: "manual", syncedAt: null },
      { ...library(), entries: [{ kind: "movie", status: "watched", genres: [], history: [] }] },
      { ...library(), items: [] },
      library([{ ...movie(), unknownField: "value" } as MediaEntry]),
      { ...library(), entries: [{ ...movie(), history: [{ ...watched("watch-1"), count: 200 }] }] },
    ]) expect(() => parseMediaImport(input)).toThrow();
  });

  it("keeps invalid input and unknown field names out of import errors", () => {
    for (const input of [
      "private-json-content-invalid",
      { ...library(), "private-field-name": "private-field-content" },
      library([movie({ title: "private-title-content", history: [watched("private-watch-id", "private-date-content")] })]),
    ]) {
      let message = "";
      try { parseMediaImport(input); } catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message).not.toBe("");
      for (const secret of ["private-json-content-invalid", "private-field-name", "private-field-content", "private-title-content", "private-watch-id", "private-date-content"]) {
        expect(message).not.toContain(secret);
      }
    }
  });
});

describe("media identities and validation", () => {
  it("gives different Trakt entities stable IDs even when their numeric IDs match", () => {
    expect(traktMediaId("movie", 17)).toBe("trakt:movie:17");
    expect(traktMediaId("show", 17)).toBe("trakt:show:17");
    expect(traktMediaId("episode", 17)).toBe("trakt:episode:17");
    const data = library([
      movie({ id: traktMediaId("movie", 17), traktId: 17 }),
      show({ id: traktMediaId("show", 17), traktId: 17 }),
      episode({ id: traktMediaId("episode", 17), traktId: 17, showId: traktMediaId("show", 17) }),
    ]);
    expect(mediaLibrarySchema.safeParse(data).success).toBe(true);
    for (const invalid of [movie({ traktId: 17 }), movie({ id: "trakt:show:17", traktId: 17 }), movie({ traktId: 0 })]) {
      expect(mediaEntrySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects duplicate entry IDs and duplicate history IDs across the whole library", () => {
    expect(mediaLibrarySchema.safeParse(library([movie(), movie()])).success).toBe(false);
    expect(mediaLibrarySchema.safeParse(library([movie({ history: [watched("repeat"), watched("repeat")] })])).success).toBe(false);
    expect(mediaLibrarySchema.safeParse(library([
      movie({ history: [watched("repeat")] }), show({ history: [watched("repeat")] }),
    ])).success).toBe(false);
  });

  it("requires episode coordinates and keeps them off movies and shows", () => {
    expect(mediaEntrySchema.safeParse(episode({ season: 0 })).success).toBe(true);
    expect(mediaLibrarySchema.safeParse(library([episode()])).success).toBe(true);
    expect(mediaLibrarySchema.safeParse(library([movie(), episode({ showId: "manual-movie" })])).success).toBe(false);
    expect(mediaEntrySchema.safeParse(episode({ showId: "manual-episode" })).success).toBe(false);
    for (const field of ["showId", "season", "episode"] as const) {
      const missing: Record<string, unknown> = { ...episode() };
      delete missing[field];
      expect(mediaEntrySchema.safeParse(missing).success).toBe(false);
      for (const entry of [movie(), show()]) {
        expect(mediaEntrySchema.safeParse({ ...entry, [field]: episode()[field] }).success).toBe(false);
      }
    }
  });

  it("checks numeric boundaries rather than accepting impossible media values", () => {
    expect(mediaEntrySchema.safeParse(movie({ year: 1880, rating: 0 })).success).toBe(true);
    expect(mediaEntrySchema.safeParse(movie({ year: 2200, rating: 10 })).success).toBe(true);
    expect(mediaEntrySchema.safeParse(episode({ season: 1000, episode: 10000 })).success).toBe(true);
    for (const invalid of [
      movie({ year: 1879 }), movie({ year: 2201 }), movie({ year: 2026.5 }),
      movie({ rating: -0.1 }), movie({ rating: 10.1 }), movie({ rating: Number.NaN }),
      episode({ season: -1 }), episode({ season: 1001 }), episode({ season: 1.5 }),
      episode({ episode: 0 }), episode({ episode: 10001 }), episode({ episode: 1.5 }),
    ]) expect(mediaEntrySchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts real calendar dates and timestamps with a timezone", () => {
    for (const watchedAt of ["2024-02-29", "2026-10-07T12:00:00Z", "2026-10-07T12:00:00+08:00"]) {
      expect(mediaEntrySchema.safeParse(movie({ history: [watched("watch-1", watchedAt)] })).success).toBe(true);
    }
    for (const watchedAt of ["2023-02-29", "2026-04-31", "2026-13-01", "明天", "2026-10-07T12:00:00"]) {
      expect(mediaEntrySchema.safeParse(movie({ history: [watched("watch-1", watchedAt)] })).success).toBe(false);
    }
    expect(mediaLibrarySchema.safeParse(library([], { syncedAt: "2026-10-07T12:00:00" })).success).toBe(false);
  });

  it("accepts only official HTTPS Trakt movie and show links", () => {
    expect(mediaEntrySchema.safeParse(movie({ traktUrl: "https://trakt.tv/movies/example-2026" })).success).toBe(true);
    expect(mediaEntrySchema.safeParse(show({ traktUrl: "https://trakt.tv/shows/example" })).success).toBe(true);
    expect(mediaEntrySchema.safeParse(episode({ traktUrl: "https://trakt.tv/shows/example/seasons/1/episodes/1" })).success).toBe(true);
    expect(mediaEntrySchema.safeParse(movie({ traktUrl: "https://trakt.tv/shows/example" })).success).toBe(false);
    expect(mediaEntrySchema.safeParse(show({ traktUrl: "https://trakt.tv/shows/example/seasons/1/episodes/1" })).success).toBe(false);
    for (const traktUrl of [
      "http://trakt.tv/movies/example", "https://trakt.tv.evil.test/movies/example", "https://other.test/movies/example",
      "https://user:password@trakt.tv/movies/example", "https://trakt.tv:8443/movies/example", "https://trakt.tv/search",
      "https://trakt.tv/movies/\nexample", "/movies/example", "javascript:alert(1)",
    ]) expect(mediaEntrySchema.safeParse(movie({ traktUrl })).success).toBe(false);
  });

  it("bounds entry counts, per-entry history and total imported history", () => {
    const entries = Array.from({ length: 10001 }, (_, index) => movie({ id: `entry-${index}` }));
    expect(mediaLibrarySchema.safeParse(library(entries)).success).toBe(false);
    const history = Array.from({ length: 5001 }, (_, index) => watched(`watch-${index}`));
    expect(mediaEntrySchema.safeParse(movie({ history })).success).toBe(false);
    const total = Array.from({ length: 11 }, (_, entryIndex) => movie({
      id: `entry-${entryIndex}`,
      history: Array.from({ length: entryIndex === 10 ? 1 : 5000 }, (_, index) => watched(`watch-${entryIndex}-${index}`)),
    }));
    expect(mediaLibrarySchema.safeParse(library(total)).success).toBe(false);
  });
});

describe("media import merge", () => {
  it("retains a known classification when new metadata does not establish one", () => {
    const existing = library([movie({ status: "watched", thought: "我的感受" }), show({ status: "watching" })]);
    const incoming = library([movie({ status: "unclassified", rating: 9 }), show({ status: "unclassified" })], { source: "trakt" });
    const merged = mergeMediaLibraries(existing, incoming);
    expect(merged.entries.map(entry => entry.status)).toEqual(["watched", "watching"]);
    expect(merged.entries[0].rating).toBe(9);
    expect(merged.entries[0].thought).toBe("我的感受");
    expect(merged.entries[0].history).toEqual([]);
    expect(mergeMediaLibraries(existing, library([show({ status: "wanted" })])).entries[1].status).toBe("wanted");
  });
  it("updates matching entries while retaining manual entries, metadata, thoughts and watch history", () => {
    const existing = library([
      movie({ year: 2024, rating: 8, traktUrl: "https://trakt.tv/movies/example", thought: "  本地原文\n保留  ", history: [watched("old"), watched("shared")] }),
      show(),
    ], { syncedAt: "2026-10-06T10:00:00Z" });
    const incoming = library([
      movie({ title: "更新片名", status: "watched", genres: ["悬疑"], history: [watched("shared"), watched("new")] }),
      episode(),
    ], { source: "trakt", syncedAt: "2026-10-07T10:00:00Z" });
    const originalExisting = structuredClone(existing);
    const originalIncoming = structuredClone(incoming);
    const merged = mergeMediaLibraries(existing, incoming);
    expect(merged.entries.map(entry => entry.id)).toEqual(["manual-movie", "manual-show", "manual-episode"]);
    expect(merged.entries[0]).toEqual({ ...existing.entries[0], ...incoming.entries[0], thought: existing.entries[0].thought,
      history: [watched("old"), watched("shared"), watched("new")] });
    expect(merged.source).toBe("trakt");
    expect(merged.syncedAt).toBe(incoming.syncedAt);
    expect(existing).toEqual(originalExisting);
    expect(incoming).toEqual(originalIncoming);
    merged.entries[0].history.push(watched("mutated-result"));
    merged.entries[0].genres.push("结果修改");
    expect(existing).toEqual(originalExisting);
    expect(incoming).toEqual(originalIncoming);
  });

  it("allows an explicit empty thought and preserves the prior sync time when no new time is supplied", () => {
    const existing = library([movie({ thought: "旧想法" })], { syncedAt: "2026-10-06T10:00:00Z" });
    const merged = mergeMediaLibraries(existing, library([movie({ thought: "" })]));
    expect(merged.entries[0].thought).toBe("");
    expect(merged.syncedAt).toBe(existing.syncedAt);
  });

  it("rejects conflicting watch events rather than silently moving their watch date", () => {
    const existing = library([movie({ history: [watched("watch-1", "2026-10-06")] })]);
    const incoming = library([movie({ history: [watched("watch-1", "2026-10-07")] })]);
    expect(() => mergeMediaLibraries(existing, incoming)).toThrow();
    expect(existing.entries[0].history[0].watchedAt).toBe("2026-10-06");
    expect(incoming.entries[0].history[0].watchedAt).toBe("2026-10-07");
  });

  it("rejects entry kind collisions and history IDs reused by a different entry", () => {
    expect(() => mergeMediaLibraries(library([movie()]), library([show({ id: "manual-movie" })]))).toThrow();
    expect(() => mergeMediaLibraries(
      library([movie({ history: [watched("watch-1")] })]),
      library([show({ history: [watched("watch-1")] })]),
    )).toThrow();
  });
});
