import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backupSchema } from "./backup";
import { emptyLifeBoardData, emptyLifeData, lifeBoardSchema, lifeDataSchema, lifeObservationSchema, lifeReviewSchema, lifeThreadSchema, mergeLifeBackups } from "./life";
import type { LifeBoardData, LifeData, LifeObservation, LifeReview, LifeThread } from "./life";
import { emptyMediaLibrary } from "./media";
import { emptyFinanceLibrary } from "./finance";

const timestamp = "2026-10-07T12:00:00+08:00";
const thread = (): LifeThread => ({
  id: randomUUID(), title: "我想持续了解的事", area: "思考", kind: "question", state: "active",
  description: "  还没有结论，也不急着变成任务。\n保留这段原话。  ", createdAt: timestamp, updatedAt: timestamp,
});
const observation = (threadId?: string): LifeObservation => ({
  id: randomUUID(), ...(threadId === undefined ? {} : { threadId }), area: "生活", kind: "discovery",
  text: "  今天发现，留一点空白也让我安心。\n这是原文。  ", date: "2026-10-07", createdAt: timestamp,
});
const review = (): LifeReview => ({
  id: randomUUID(), date: "2026-10-07", title: "这一段日子的回看", noticed: "注意到了自己的节奏。",
  changed: "", keep: "  想保留散步时的安静。  ", createdAt: timestamp,
});
const fullBoard = (): LifeBoardData => {
  const item = thread();
  return { threads: [item], observations: [observation(item.id)], reviews: [review()] };
};

function existingLife(): LifeData {
  return {
    ...emptyLifeData(),
    reading: { version: 1, source: "manual", books: [{ id: "demo-book", title: "示例书籍", author: "作者", kind: "ebook", status: "reading" }],
      highlights: [{ id: "demo-highlight", bookId: "demo-book", text: "  阅读原摘录。  ", thought: "自己的阅读想法。" }], stats: null, syncedAt: null },
    thoughts: [{ id: randomUUID(), title: "阅读之后", body: "  独立思考的原话。\n不要在迁移中丢失。  ", createdAt: timestamp,
      updatedAt: timestamp, bookId: "demo-book", highlightId: "demo-highlight", sourceExcerpt: "  阅读原摘录。  " }],
    board: fullBoard(),
  };
}

describe("life board schema and migration", () => {
  it("adds an empty board to old life data without changing reading or thoughts", () => {
    const existing = existingLife();
    const legacy = { reading: existing.reading, thoughts: existing.thoughts };
    const migrated = lifeDataSchema.parse(legacy);
    expect(migrated).toEqual({ ...legacy, board: { threads: [], observations: [], reviews: [] }, media: emptyMediaLibrary(), finance: emptyFinanceLibrary() });
    expect(migrated.thoughts[0].body).toBe(existing.thoughts[0].body);
    expect(migrated.reading.highlights[0].text).toBe(existing.reading.highlights[0].text);
  });

  it("accepts existing v2 backups without changing the backup format or version", () => {
    const { reading, thoughts } = existingLife();
    const parsed = backupSchema.parse({ format: "life-workbench-backup", version: 2, exportedAt: timestamp,
      tasks: [], sources: [], life: { reading, thoughts } });
    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("Expected v2 fixture");
    expect(parsed.life.board).toEqual(emptyLifeBoardData());
    expect(parsed.life.reading).toEqual(reading);
    expect(parsed.life.thoughts).toEqual(thoughts);
  });

  it("creates independent empty arrays for each helper call and default migration", () => {
    const first = emptyLifeData();
    const second = emptyLifeData();
    first.board.threads.push(thread());
    expect(second.board).toEqual(emptyLifeBoardData());
    const legacy = { reading: second.reading, thoughts: [] };
    const migratedFirst = lifeDataSchema.parse(legacy);
    const migratedSecond = lifeDataSchema.parse(legacy);
    migratedFirst.board.observations.push(observation());
    expect(migratedSecond.board.observations).toEqual([]);
  });

  it("validates actual calendar dates and timezone-bearing ISO timestamps", () => {
    expect(lifeObservationSchema.safeParse({ ...observation(), date: "2024-02-29" }).success).toBe(true);
    expect(lifeReviewSchema.safeParse({ ...review(), date: "2000-02-29" }).success).toBe(true);
    for (const date of ["2023-02-29", "2100-02-29", "2026-04-31", "2026-13-01", "2026-1-1", "明天", "0000-01-01"]) {
      expect(lifeObservationSchema.safeParse({ ...observation(), date }).success, date).toBe(false);
      expect(lifeReviewSchema.safeParse({ ...review(), date }).success, date).toBe(false);
    }
    expect(lifeThreadSchema.safeParse({ ...thread(), createdAt: "2026-10-07T12:00:00" }).success).toBe(false);
    expect(lifeThreadSchema.safeParse({ ...thread(), updatedAt: "2026-02-30T12:00:00Z" }).success).toBe(false);
  });

  it("requires real content and at least one nonblank reflection while preserving wording", () => {
    expect(lifeObservationSchema.safeParse({ ...observation(), text: " \n\t " }).success).toBe(false);
    expect(lifeReviewSchema.safeParse({ ...review(), noticed: " \n ", changed: "", keep: "\t" }).success).toBe(false);
    const originalReview = { ...review(), noticed: "  原来的表达。\n下一行。  ", changed: "", keep: "" };
    expect(lifeReviewSchema.parse(originalReview).noticed).toBe(originalReview.noticed);
    const originalObservation = observation();
    expect(lifeObservationSchema.parse(originalObservation).text).toBe(originalObservation.text);
    expect(lifeThreadSchema.parse(thread()).description.startsWith("  ")).toBe(true);
  });

  it("keeps an observation after its original thread is removed", () => {
    const deletedThreadId = randomUUID();
    const original = observation(deletedThreadId);
    expect(lifeBoardSchema.parse({ threads: [], observations: [original], reviews: [] }).observations[0]).toEqual(original);
    expect(lifeObservationSchema.safeParse({ ...original, threadId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects duplicate record IDs, unknown fields and unsupported classification", () => {
    const item = thread();
    expect(lifeBoardSchema.safeParse({ threads: [item, item], observations: [], reviews: [] }).success).toBe(false);
    expect(lifeBoardSchema.safeParse({ threads: [item], observations: [{ ...observation(), id: item.id }], reviews: [] }).success).toBe(false);
    expect(lifeBoardSchema.safeParse({ ...emptyLifeBoardData(), tasks: [] }).success).toBe(false);
    expect(lifeThreadSchema.safeParse({ ...thread(), kind: "task" }).success).toBe(false);
    expect(lifeThreadSchema.safeParse({ ...thread(), state: "done" }).success).toBe(false);
    expect(lifeThreadSchema.safeParse({ ...thread(), area: "不支持的领域" }).success).toBe(false);
  });

  it("enforces the published title and original-text limits", () => {
    expect(lifeThreadSchema.safeParse({ ...thread(), title: "字".repeat(200), description: "字".repeat(5_000) }).success).toBe(true);
    expect(lifeThreadSchema.safeParse({ ...thread(), title: "字".repeat(201) }).success).toBe(false);
    expect(lifeThreadSchema.safeParse({ ...thread(), description: "字".repeat(5_001) }).success).toBe(false);
    expect(lifeObservationSchema.safeParse({ ...observation(), text: "字".repeat(5_001) }).success).toBe(false);
    for (const field of ["noticed", "changed", "keep"] as const) {
      expect(lifeReviewSchema.safeParse({ ...review(), [field]: "字".repeat(5_001) }).success).toBe(false);
    }
  });
});

describe("life board backup merge", () => {
  it("retains the later reading sync instant across different valid timezone offsets", () => {
    const existing = emptyLifeData();
    const incoming = emptyLifeData();
    existing.reading.syncedAt = "2026-10-08T00:30:00+08:00";
    incoming.reading.syncedAt = "2026-10-07T18:00:00Z";
    expect(mergeLifeBackups(existing, incoming).reading.syncedAt).toBe(incoming.reading.syncedAt);
    expect(mergeLifeBackups(incoming, existing).reading.syncedAt).toBe(incoming.reading.syncedAt);
  });

  it("adds all three collections, preserves reading and original words, and makes retries idempotent", () => {
    const existing = existingLife();
    const incoming = { ...emptyLifeData(), board: fullBoard() };
    const originalExisting = structuredClone(existing);
    const originalIncoming = structuredClone(incoming);
    const merged = mergeLifeBackups(existing, incoming);
    expect(merged.board.threads).toEqual([...existing.board.threads, ...incoming.board.threads]);
    expect(merged.board.observations).toEqual([...existing.board.observations, ...incoming.board.observations]);
    expect(merged.board.reviews).toEqual([...existing.board.reviews, ...incoming.board.reviews]);
    expect(merged.reading).toEqual(existing.reading);
    expect(merged.thoughts).toEqual(existing.thoughts);
    expect(mergeLifeBackups(merged, incoming)).toEqual(merged);
    expect(existing).toEqual(originalExisting);
    expect(incoming).toEqual(originalIncoming);
  });

  it.each(["threads", "observations", "reviews"] as const)("rejects a %s conflict without modifying either input or adding earlier records", collection => {
    const existing = existingLife();
    const incoming = { ...emptyLifeData(), board: fullBoard() };
    if (collection === "threads") incoming.board.threads.push({ ...existing.board.threads[0], description: "冲突的新描述" });
    if (collection === "observations") incoming.board.observations.push({ ...existing.board.observations[0], text: "冲突的新原文" });
    if (collection === "reviews") incoming.board.reviews.push({ ...existing.board.reviews[0], noticed: "冲突的新回顾" });
    const originalExisting = structuredClone(existing);
    const originalIncoming = structuredClone(incoming);
    expect(() => mergeLifeBackups(existing, incoming)).toThrow("未恢复任何内容");
    expect(existing).toEqual(originalExisting);
    expect(incoming).toEqual(originalIncoming);
  });

  it("keeps a populated board when restoring a migrated older life backup", () => {
    const existing = existingLife();
    const migrated = lifeDataSchema.parse({ reading: existing.reading, thoughts: existing.thoughts });
    expect(mergeLifeBackups(existing, migrated)).toEqual(existing);
  });
});

describe("media migration and backup merge", () => {
  it("adds an independent empty media module to pre-media life data and v2 backups without changing existing modules", () => {
    const existing = existingLife();
    const legacy = { reading: existing.reading, thoughts: existing.thoughts, board: existing.board };
    const migrated = lifeDataSchema.parse(legacy);
    expect(migrated).toEqual({ ...legacy, media: emptyMediaLibrary(), finance: emptyFinanceLibrary() });
    migrated.media.entries.push({ id: "local-movie", kind: "movie", title: "仅用于这次读取", status: "watched", genres: [], history: [] });
    expect(lifeDataSchema.parse(legacy).media.entries).toEqual([]);
    const backup = backupSchema.parse({ format: "life-workbench-backup", version: 2, exportedAt: timestamp, tasks: [], sources: [], life: legacy });
    if (backup.version !== 2) throw new Error("Expected v2 fixture");
    expect(backup.life).toEqual({ ...legacy, media: emptyMediaLibrary(), finance: emptyFinanceLibrary() });
    expect(legacy).not.toHaveProperty("media");
  });

  it("adds distinct media entries from backups, keeps real watch histories and makes repeated recovery idempotent", () => {
    const existing = existingLife();
    existing.media = { version: 1, source: "trakt", syncedAt: "2026-10-08T00:30:00+08:00", entries: [{
      id: "trakt:movie:17", traktId: 17, title: "已看电影", kind: "movie", status: "watched", genres: ["剧情"], rating: 8,
      history: [{ id: "trakt:history:1", watchedAt: "2026-10-07" }], thought: "  感想原文\n第二行  ", traktUrl: "https://trakt.tv/movies/example",
    }] };
    const incoming = emptyLifeData();
    incoming.media = { version: 1, source: "trakt", syncedAt: "2026-10-07T18:00:00Z", entries: [{
      id: "trakt:show:17", traktId: 17, title: "还在看的剧集", kind: "show", status: "watching", genres: [], history: [],
    }] };
    const before = structuredClone(existing);
    const merged = mergeLifeBackups(existing, incoming);
    expect(merged.media.entries).toEqual([...existing.media.entries, ...incoming.media.entries]);
    expect(merged.media.syncedAt).toBe(incoming.media.syncedAt);
    expect(merged.media.entries.map(entry => entry.history.length)).toEqual([1, 0]);
    expect(mergeLifeBackups(merged, incoming)).toEqual(merged);
    const legacy = lifeDataSchema.parse({ reading: existing.reading, thoughts: existing.thoughts, board: existing.board });
    expect(mergeLifeBackups(existing, legacy)).toEqual(existing);
    expect(existing).toEqual(before);
  });
});
