import { z } from "zod";
import { emptyReadingLibrary, readingLibrarySchema, type ReadingLibrary } from "./reading";

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

export const lifeDataSchema = z.object({
  reading: readingLibrarySchema,
  thoughts: z.array(lifeThoughtSchema).max(5_000),
}).strict().superRefine((life, context) => {
  if (new Set(life.thoughts.map(thought => thought.id)).size !== life.thoughts.length) {
    context.addIssue({ code: "custom", message: "思考存在重复编号。" });
  }
  // A saved source excerpt remains useful even if its book is later removed.
});
export type LifeData = z.infer<typeof lifeDataSchema>;

export function emptyLifeData(): LifeData { return { reading: emptyReadingLibrary(), thoughts: [] }; }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
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
    syncedAt: [existing.reading.syncedAt, incoming.reading.syncedAt].filter((value): value is string => value !== null).sort().at(-1) ?? null,
    source: existing.reading.source === "weread" || incoming.reading.source === "weread" ? "weread" : "manual",
  };
  return lifeDataSchema.parse({ reading, thoughts: merge(existing.thoughts, incoming.thoughts, "思考") });
}
