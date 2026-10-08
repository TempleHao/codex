import { z } from "zod";
import { emptyReadingLibrary, readingLibrarySchema, type ReadingLibrary } from "./reading";
import { AREAS } from "./types";

const lifeAreaSchema = z.enum(AREAS);
const lifeTimestampSchema = z.iso.datetime({ offset: true });
const lifeDateSchema = z.iso.date().refine(value => !value.startsWith("0000-"), "日期必须是实际存在的 YYYY-MM-DD 日期。");
const lifeTitleSchema = z.string().trim().min(1).max(200);

/** A life thread describes something worth returning to, without requiring a task. */
export const lifeThreadSchema = z.object({
  id: z.uuid(),
  title: lifeTitleSchema,
  area: lifeAreaSchema,
  kind: z.enum(["interest", "concern", "question", "direction"]),
  state: z.enum(["active", "resting", "archived"]),
  description: z.string().max(5_000),
  createdAt: lifeTimestampSchema,
  updatedAt: lifeTimestampSchema,
}).strict();
export type LifeThread = z.infer<typeof lifeThreadSchema>;

export const lifeObservationSchema = z.object({
  id: z.uuid(),
  threadId: z.uuid().optional(),
  area: lifeAreaSchema,
  kind: z.enum(["experience", "feeling", "discovery"]),
  // Preserve the original wording and whitespace while rejecting empty entries.
  text: z.string().max(5_000).refine(value => Boolean(value.trim()), "请留下经历、感受或发现。"),
  date: lifeDateSchema,
  createdAt: lifeTimestampSchema,
}).strict();
export type LifeObservation = z.infer<typeof lifeObservationSchema>;

export const lifeReviewSchema = z.object({
  id: z.uuid(),
  date: lifeDateSchema,
  title: lifeTitleSchema,
  noticed: z.string().max(5_000),
  changed: z.string().max(5_000),
  keep: z.string().max(5_000),
  createdAt: lifeTimestampSchema,
}).strict().refine(review => Boolean(review.noticed.trim() || review.changed.trim() || review.keep.trim()), "请至少写下一项发现、变化或想保留的事。");
export type LifeReview = z.infer<typeof lifeReviewSchema>;

export const lifeBoardSchema = z.object({
  threads: z.array(lifeThreadSchema),
  observations: z.array(lifeObservationSchema),
  reviews: z.array(lifeReviewSchema),
}).strict().superRefine((board, context) => {
  const ids = new Set<string>();
  for (const collection of ["threads", "observations", "reviews"] as const) {
    board[collection].forEach((item, index) => {
      if (ids.has(item.id)) context.addIssue({ code: "custom", path: [collection, index, "id"], message: "人生记录存在重复编号。" });
      ids.add(item.id);
    });
  }
  // Observations keep their original threadId even if that thread is later removed.
});
export type LifeBoardData = z.infer<typeof lifeBoardSchema>;

export function emptyLifeBoardData(): LifeBoardData { return { threads: [], observations: [], reviews: [] }; }

export const lifeThoughtSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  bookId: z.string().min(1).max(200).optional(),
  highlightId: z.string().min(1).max(200).optional(),
  sourceExcerpt: z.string().max(20_000).optional(),
}).strict();
export type LifeThought = z.infer<typeof lifeThoughtSchema>;

const lifeThoughtsSchema = z.array(lifeThoughtSchema).max(5_000).superRefine((thoughts, context) => {
  if (new Set(thoughts.map(thought => thought.id)).size !== thoughts.length) {
    context.addIssue({ code: "custom", message: "思考存在重复编号。" });
  }
});

export const lifeDataSchema = z.object({
  reading: readingLibrarySchema,
  thoughts: lifeThoughtsSchema,
  board: lifeBoardSchema.default(emptyLifeBoardData),
}).strict();
// A saved source excerpt remains useful even if its book is later removed.
export type LifeData = z.infer<typeof lifeDataSchema>;

export function emptyLifeData(): LifeData { return { reading: emptyReadingLibrary(), thoughts: [], board: emptyLifeBoardData() }; }

/** Save one module only if its original snapshot still matches persisted data. */
export const lifePatchSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("board"), expected: lifeBoardSchema, value: lifeBoardSchema }).strict(),
  z.object({ section: z.literal("reading"), expected: readingLibrarySchema, value: readingLibrarySchema }).strict(),
  z.object({ section: z.literal("thoughts"), expected: lifeThoughtsSchema, value: lifeThoughtsSchema }).strict(),
]);
export type LifePatch = z.infer<typeof lifePatchSchema>;
export class LifePatchConflict extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function applyLifePatch(existing: LifeData, patch: LifePatch): LifeData {
  if (canonical(existing[patch.section]) !== canonical(patch.expected)) {
    const label = { board: "人生看板", reading: "阅读记录", thoughts: "思考记录" }[patch.section];
    throw new LifePatchConflict(`其他页面更新了${label}，未保存本次内容。请保留草稿，重新查看最新记录后再保存。`);
  }
  return lifeDataSchema.parse({ ...existing, [patch.section]: patch.value });
}

/** Backup recovery adds records and rejects ambiguous ID conflicts before writing. */
export function mergeLifeBackups(existing: LifeData, incoming: LifeData): LifeData {
  if (existing.reading.stats && incoming.reading.stats && canonical(existing.reading.stats) !== canonical(incoming.reading.stats)) {
    throw new Error("备份阅读统计与现有记录冲突，未恢复任何内容。请保留两份备份后核对。");
  }
  const merge = <T extends { id: string }>(before: T[], after: T[], label: string): T[] => {
    const records = new Map(before.map(item => [item.id, item]));
    for (const item of after) {
      const previous = records.get(item.id);
      if (previous && canonical(previous) !== canonical(item)) throw new Error(`备份${label}与现有记录冲突，未恢复任何内容。请保留两份备份后核对。`);
      if (!previous) records.set(item.id, item);
    }
    return [...records.values()];
  };
  const reading: ReadingLibrary = {
    version: 1,
    books: merge(existing.reading.books, incoming.reading.books, "书籍"),
    highlights: merge(existing.reading.highlights, incoming.reading.highlights, "阅读笔记"),
    stats: existing.reading.stats ?? incoming.reading.stats,
    syncedAt: [existing.reading.syncedAt, incoming.reading.syncedAt].filter((value): value is string => value !== null).sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1) ?? null,
    source: existing.reading.source === "weread" || incoming.reading.source === "weread" ? "weread" : "manual",
  };
  const board: LifeBoardData = {
    threads: merge(existing.board.threads, incoming.board.threads, "人生线头"),
    observations: merge(existing.board.observations, incoming.board.observations, "经历与发现"),
    reviews: merge(existing.board.reviews, incoming.board.reviews, "人生回顾"),
  };
  return lifeDataSchema.parse({ reading, thoughts: merge(existing.thoughts, incoming.thoughts, "思考"), board });
}
