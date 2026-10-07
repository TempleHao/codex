import { z } from "zod";

export const READING_MODES = ["weekly", "monthly", "annually", "overall"] as const;
export type ReadingMode = (typeof READING_MODES)[number];

/** Only absolute HTTPS URLs and links supplied by WeRead are accepted. */
export function isSafeReadingLink(value: string): boolean {
  if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && Boolean(url.hostname)
      && (url.protocol === "https:" || (url.protocol === "weread:" && /^weread:\/\//i.test(value)));
  } catch { return false; }
}

const idSchema = z.string().trim().min(1).max(200);
const dateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const timestampSchema = z.iso.datetime({ offset: true });
const secondsSchema = z.number().finite().nonnegative();
const linkSchema = z.string().max(2_000).refine(isSafeReadingLink, "链接必须使用 https:// 或 weread://");
const coverSchema = z.string().max(2_000).refine(value => isSafeReadingLink(value) && new URL(value).protocol === "https:", "封面必须使用 HTTPS 链接");

export const readingBookSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().max(500),
  kind: z.enum(["ebook", "audiobook", "article"]),
  status: z.enum(["wanted", "reading", "finished"]),
  cover: coverSchema.optional(),
  deepLink: linkSchema.optional(),
  progress: z.number().finite().min(0).max(100).optional(),
  finished: z.boolean().optional(),
  lastReadAt: dateSchema.optional(),
  secondsRead: secondsSchema.optional(),
}).strict();
export type ReadingBook = z.infer<typeof readingBookSchema>;

export const readingHighlightSchema = z.object({
  id: idSchema,
  bookId: idSchema,
  text: z.string().max(20_000),
  thought: z.string().max(20_000).optional(),
  chapter: z.string().max(1_000).optional(),
  createdAt: dateSchema.optional(),
  deepLink: linkSchema.optional(),
}).strict().refine(item => Boolean(item.text.trim() || item.thought?.trim()), "划线原文或想法至少填写一项");
export type ReadingHighlight = z.infer<typeof readingHighlightSchema>;

export const readingStatsSchema = z.object({
  totalSeconds: secondsSchema,
  readingDays: z.number().int().nonnegative().optional(),
  dailySeconds: z.array(z.object({ date: z.iso.date(), seconds: secondsSchema }).strict()).max(40_000),
  mode: z.enum(READING_MODES),
  period: z.object({
    start: z.iso.date().nullable(),
    baseTime: z.number().int().nonnegative(),
  }).strict().nullable(),
  preferredHours: z.array(z.object({
    hour: z.number().int().min(0).max(23), seconds: secondsSchema,
  }).strict()).max(24).optional(),
}).strict().superRefine((stats, context) => {
  if (new Set(stats.dailySeconds.map(day => day.date)).size !== stats.dailySeconds.length) {
    context.addIssue({ code: "custom", path: ["dailySeconds"], message: "每日阅读数据存在重复日期" });
  }
  if (stats.preferredHours && new Set(stats.preferredHours.map(item => item.hour)).size !== stats.preferredHours.length) {
    context.addIssue({ code: "custom", path: ["preferredHours"], message: "阅读时段存在重复小时" });
  }
});
export type ReadingStats = z.infer<typeof readingStatsSchema>;

const sourceSchema = z.enum(["manual", "weread"]);
const booksSchema = z.array(readingBookSchema).max(10_000);
const highlightsSchema = z.array(readingHighlightSchema).max(30_000);

function checkRelations(data: { books: ReadingBook[]; highlights: ReadingHighlight[] }, context: z.RefinementCtx) {
  const bookIds = new Set(data.books.map(book => book.id));
  if (bookIds.size !== data.books.length) context.addIssue({ code: "custom", path: ["books"], message: "书籍存在重复编号" });
  if (new Set(data.highlights.map(item => item.id)).size !== data.highlights.length) context.addIssue({ code: "custom", path: ["highlights"], message: "笔记存在重复编号" });
  data.highlights.forEach((highlight, index) => {
    if (!bookIds.has(highlight.bookId)) context.addIssue({ code: "custom", path: ["highlights", index, "bookId"], message: "笔记缺少关联书籍" });
  });
}

export const readingLibrarySchema = z.object({
  version: z.literal(1),
  books: booksSchema,
  highlights: highlightsSchema,
  stats: readingStatsSchema.nullable(),
  syncedAt: timestampSchema.nullable(),
  source: sourceSchema,
}).strict().superRefine(checkRelations);
export type ReadingLibrary = z.infer<typeof readingLibrarySchema>;

/** Portable import: items are books; omitted optional sections are empty. */
export const readingImportSchema = z.object({
  version: z.literal(1),
  source: sourceSchema,
  items: booksSchema,
  highlights: highlightsSchema.default([]),
  stats: readingStatsSchema.nullable().default(null),
  syncedAt: timestampSchema.nullable().default(null),
}).strict().transform(({ items, ...rest }) => ({ ...rest, books: items })).superRefine(checkRelations);

export class ReadingImportError extends Error {
  constructor(message: string) { super(message); this.name = "ReadingImportError"; }
}

export function emptyReadingLibrary(): ReadingLibrary {
  return { version: 1, books: [], highlights: [], stats: null, syncedAt: null, source: "manual" };
}

/** This function never reflects the raw input into error messages. */
export function parseReadingImport(input: string | unknown): ReadingLibrary {
  let value: unknown = input;
  if (typeof input === "string") {
    if (input.length > 2_000_000) throw new ReadingImportError("阅读文件过大，请分批导入。");
    try { value = JSON.parse(input); }
    catch { throw new ReadingImportError("阅读文件必须是完整的 JSON。"); }
  }
  const libraryShape = value !== null && typeof value === "object" && "books" in value;
  const result = (libraryShape ? readingLibrarySchema : readingImportSchema).safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {
    version: "格式版本", source: "来源", items: "书籍", books: "书籍", highlights: "笔记",
    id: "编号", bookId: "关联书籍", title: "书名", author: "作者", kind: "类型", status: "状态",
    progress: "阅读百分比", finished: "完成标记", lastReadAt: "最近阅读日期", createdAt: "笔记日期",
    syncedAt: "同步日期", stats: "阅读统计", dailySeconds: "每日阅读", totalSeconds: "总阅读秒数",
    deepLink: "阅读链接", cover: "封面链接", text: "原文", thought: "想法", chapter: "章节",
  };
  const errors = result.error.issues.slice(0, 4).map(issue => {
    const path = issue.path.map(part => typeof part === "number" ? `第 ${part + 1} 项` : fields[String(part)] ?? "字段").join(" / ");
    const message = issue.code === "custom" ? issue.message : issue.code === "unrecognized_keys" ? "包含不支持的字段" : "字段缺失或格式不正确";
    return `${path || "阅读文件"}：${message}`;
  });
  throw new ReadingImportError(errors.join("；"));
}

export function formatReadingSeconds(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`;
}

/** Incoming records replace matching IDs; records outside the import survive. */
export function mergeReadingLibraries(existing: ReadingLibrary, incoming: ReadingLibrary): ReadingLibrary {
  const mergeById = <T extends { id: string }>(before: T[], after: T[]): T[] => {
    const records = new Map(before.map(item => [item.id, item]));
    after.forEach(item => records.set(item.id, item));
    return [...records.values()];
  };
  const stats = incoming.stats ? {
    ...incoming.stats,
    dailySeconds: [...new Map([...(existing.stats?.dailySeconds ?? []), ...incoming.stats.dailySeconds].map(day => [day.date, day])).values()].sort((a, b) => a.date.localeCompare(b.date)),
  } : existing.stats;
  return readingLibrarySchema.parse({
    version: 1,
    books: mergeById(existing.books, incoming.books),
    highlights: mergeById(existing.highlights, incoming.highlights),
    stats,
    syncedAt: incoming.syncedAt ?? existing.syncedAt,
    source: incoming.source,
  });
}
