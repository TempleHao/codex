import { describe, expect, it } from "vitest";
import { mediaLibrarySchema } from "./media";
import type { MediaEntry } from "./media";
import { buildMediaWorks, mediaWorkCount, viewingDay, workStatus } from "./media-view";

const show = (overrides: Partial<MediaEntry> = {}): MediaEntry => ({
  id: "trakt:show:42", kind: "show", title: "示例剧集", genres: [], status: "unclassified", history: [], ...overrides,
});
const episode = (overrides: Partial<MediaEntry> = {}): MediaEntry => ({
  id: "trakt:episode:1", kind: "episode", title: "单集", showId: "trakt:show:42", season: 1, episode: 1,
  genres: [], status: "watched", history: [], ...overrides,
});

describe("media work review projection", () => {
  it("groups seasons and repeat watches into one work, ordering offset timestamps by actual time", () => {
    const parent = show({ thought: "整剧感想", history: [{ id: "parent", watchedAt: "2026-10-06" }] });
    const first = episode({ thought: " 第一集感想 ", history: [
      { id: "first", watchedAt: "2026-10-07T00:30:00+08:00" },
      { id: "repeat", watchedAt: "2026-10-08T12:00:00Z" },
    ] });
    const second = episode({ id: "trakt:episode:2", season: 2, thought: " \n ", history: [
      { id: "second", watchedAt: "2026-10-06T20:00:00Z" },
    ] });
    const [work] = buildMediaWorks([second, parent, first]);
    expect(work.episodes).toEqual([first, second]);
    expect(work.history.map(event => event.id)).toEqual(["repeat", "second", "first", "parent"]);
    expect(work.history[1].entry).toBe(second);
    expect(work.watchedEpisodeCount).toBe(2);
    expect(work.firstWatchedAt).toBe("2026-10-06");
    expect(work.lastWatchedAt).toBe("2026-10-08T12:00:00Z");
    expect(work.thoughts).toEqual([parent, first]);
    expect(buildMediaWorks([second, parent, first])).toHaveLength(1);
  });

  it("preserves legal episode-only imports with a neutral synthetic show and supported poster", () => {
    expect(mediaWorkCount([episode(), episode({ id: "trakt:episode:2" })])).toBe(1);
    const poster = "https://images.metahub.space/poster/medium/tt1375666/img";
    const entries = [episode({ genres: ["剧情"], thought: "留下的片段" }), episode({
      id: "trakt:episode:2", episode: 2, poster, genres: ["剧情", "喜剧"],
      history: [{ id: "watch", watchedAt: "2026-10-07" }],
    })];
    expect(mediaLibrarySchema.safeParse({ version: 1, source: "manual", syncedAt: null, entries }).success).toBe(true);
    const [work] = buildMediaWorks(entries);
    expect(work.entry).toEqual({ id: "trakt:show:42", kind: "show", title: "未命名剧集", status: "unclassified",
      history: [], genres: ["剧情", "喜剧"], poster });
    expect(work.history).toHaveLength(1);
    expect(work.thoughts).toEqual([entries[0]]);
    expect(work.watchedEpisodeCount).toBe(1);
    expect(workStatus(work)).toBe("unclassified");
  });

  it("keeps movie and show IDs distinct even when their Trakt number matches", () => {
    const movie: MediaEntry = { ...show(), id: "trakt:movie:42", kind: "movie", title: "示例电影" };
    const works = buildMediaWorks([movie, show(), episode()]);
    expect(mediaWorkCount([movie, show(), episode()])).toBe(2);
    expect(works.map(work => work.entry.id)).toEqual(["trakt:movie:42", "trakt:show:42"]);
    expect(works[0].episodes).toEqual([]);
    expect(works[1].episodes).toHaveLength(1);
  });

  it("does not mutate source entries, history order, thoughts or status", () => {
    const entries = [show(), episode({ thought: "  原文  ", history: [
      { id: "older", watchedAt: "2025-01-01" }, { id: "newer", watchedAt: "2026-01-01" },
    ] })];
    const before = structuredClone(entries);
    for (const entry of entries) { Object.freeze(entry.history); Object.freeze(entry.genres); Object.freeze(entry); }
    Object.freeze(entries);
    workStatus(buildMediaWorks(entries)[0]);
    expect(entries).toEqual(before);
  });

  it("does not invent dates or completed shows from an episode's watched classification", () => {
    const [work] = buildMediaWorks([show(), episode()]);
    expect(work.history).toEqual([]);
    expect(work.firstWatchedAt).toBeUndefined();
    expect(work.lastWatchedAt).toBeUndefined();
    expect(work.watchedEpisodeCount).toBe(0);
    expect(workStatus(work)).toBe("unclassified");
    const dated = episode({ history: [{ id: "actual", watchedAt: "2026-10-07" }] });
    expect(workStatus(buildMediaWorks([show(), dated])[0])).toBe("unclassified");
    for (const status of ["wanted", "watching", "watched"] as const) {
      expect(workStatus(buildMediaWorks([show({ status }), dated])[0])).toBe(status);
    }
    const parentOnly = show({ history: [{ id: "parent-only", watchedAt: "2026-10-07" }] });
    expect(workStatus(buildMediaWorks([parentOnly])[0])).toBe("unclassified");
  });

  it("uses Shanghai calendar days for timestamps and preserves undated classifications", () => {
    expect(viewingDay("2026-10-07")).toBe("2026-10-07");
    expect(viewingDay("2026-10-06T20:00:00Z")).toBe("2026-10-07");
    expect(viewingDay("2026-10-07T23:30:00-04:00")).toBe("2026-10-08");
    expect(viewingDay("")).toBe("");
  });
});
