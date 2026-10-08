import { z } from "zod";

export const MEDIA_KINDS = ["movie", "show", "episode"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const MEDIA_STATUSES = ["wanted", "watching", "watched", "unclassified"] as const;
export const MAX_MEDIA_IMPORT_BYTES = 5_000_000;

const idSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.iso.datetime({ offset: true }).refine(value => !value.startsWith("0000-"), "观看日期必须是真实日期。");
const watchedAtSchema = z.union([
  z.iso.date().refine(value => !value.startsWith("0000-"), "观看日期必须是真实日期。"),
  timestampSchema,
]);

/** Entity prefixes prevent a movie, show and episode with the same Trakt number from colliding. */
export function traktMediaId(kind: MediaKind, id: number): string {
  if (!MEDIA_KINDS.includes(kind) || !Number.isSafeInteger(id) || id < 1) throw new Error("Trakt 编号格式不正确。");
  return `trakt:${kind}:${id}`;
}

/** Keep imported links on official HTTPS title pages, without credentials or tracking queries. */
export function isSafeTraktLink(value: string): boolean {
  if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "trakt.tv" && !url.username && !url.password
      && !url.port && !url.search && !url.hash
      && /^\/(?:movies\/[a-z0-9-]+|shows\/[a-z0-9-]+(?:\/seasons\/\d+\/episodes\/\d+)?)(?:\/)?$/i.test(url.pathname);
  } catch { return false; }
}

export function imdbPoster(id: unknown): string | undefined {
  return typeof id === "string" && /^tt\d{5,12}$/.test(id) ? `https://images.metahub.space/poster/medium/${id}/img` : undefined;
}

export function isLegacyTraktPoster(value: unknown): boolean {
  const poster = normalizeMediaPoster(value);
  return poster !== undefined && new URL(poster).hostname === "walter-r2.trakt.tv";
}

/** Preserve imported Trakt URLs and allow only the documented IMDb poster endpoint. */
export function normalizeMediaPoster(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000 || /[\u0000-\u0020\u007f]/u.test(value)) return;
  if (/^https:\/\/images\.metahub\.space\/poster\/medium\/tt\d{5,12}\/img$/.test(value)) return value;
  try {
    const url = new URL(value.startsWith("walter-r2.trakt.tv/") ? `https://${value}` : value);
    if (url.protocol !== "https:" || url.hostname !== "walter-r2.trakt.tv" || url.username || url.password || url.port || url.search || url.hash) return;
    if (!/^\/images\/[a-z0-9/_-]+\.(?:jpg|jpeg|png)\.webp$/i.test(url.pathname) || url.pathname.includes("//")) return;
    return url.href;
  } catch { return; }
}

export const mediaHistorySchema = z.object({
  id: idSchema,
  watchedAt: watchedAtSchema,
}).strict();
export type MediaHistory = z.infer<typeof mediaHistorySchema>;

export const mediaEntrySchema = z.object({
  id: idSchema,
  kind: z.enum(MEDIA_KINDS),
  title: z.string().trim().min(1).max(500),
  year: z.number().int().min(1880).max(2200).optional(),
  genres: z.array(z.string().trim().min(1).max(100)).max(30),
  status: z.enum(MEDIA_STATUSES),
  rating: z.number().finite().min(0).max(10).optional(),
  // A watched status is not a dated viewing. Counts come only from these supplied events.
  history: z.array(mediaHistorySchema).max(5_000),
  traktId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  imdbId: z.string().regex(/^tt\d{5,12}$/).optional(),
  traktUrl: z.string().max(2_000).refine(isSafeTraktLink, "Trakt 链接必须是官方 HTTPS 作品页面。").optional(),
  poster: z.string().max(2_000).refine(value => normalizeMediaPoster(value) === value, "海报必须使用支持的 HTTPS 图片地址。").optional(),
  showId: idSchema.optional(),
  season: z.number().int().min(0).max(1_000).optional(),
  episode: z.number().int().min(1).max(10_000).optional(),
  thought: z.string().max(20_000).optional(),
}).strict().superRefine((entry, context) => {
  if (entry.traktId !== undefined && Number.isSafeInteger(entry.traktId) && entry.traktId > 0 && entry.id !== traktMediaId(entry.kind, entry.traktId)) {
    context.addIssue({ code: "custom", path: ["id"], message: "Trakt 作品编号与作品类型不一致。" });
  }
  if (entry.kind === "episode") {
    for (const field of ["showId", "season", "episode"] as const) {
      if (entry[field] === undefined) context.addIssue({ code: "custom", path: [field], message: "单集必须保留所属剧集、季和集编号。" });
    }
    if (entry.showId === entry.id) context.addIssue({ code: "custom", path: ["showId"], message: "单集不能属于自身。" });
  } else {
    for (const field of ["showId", "season", "episode"] as const) {
      if (entry[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "季和集信息只适用于单集。" });
    }
  }
  if (new Set(entry.history.map(event => event.id)).size !== entry.history.length) {
    context.addIssue({ code: "custom", path: ["history"], message: "观看记录存在重复编号。" });
  }
  if (entry.traktUrl && isSafeTraktLink(entry.traktUrl)) {
    const path = new URL(entry.traktUrl).pathname;
    const matchesKind = entry.kind === "movie" ? path.startsWith("/movies/")
      : entry.kind === "episode" ? /^\/shows\/.+\/seasons\/\d+\/episodes\/\d+\/?$/i.test(path)
        : path.startsWith("/shows/") && !path.includes("/seasons/");
    if (!matchesKind) context.addIssue({ code: "custom", path: ["traktUrl"], message: "Trakt 链接与作品类型不一致。" });
  }
});
export type MediaEntry = z.infer<typeof mediaEntrySchema>;

export const mediaLibrarySchema = z.object({
  version: z.literal(1),
  source: z.enum(["manual", "trakt"]),
  syncedAt: timestampSchema.nullable(),
  entries: z.array(mediaEntrySchema).max(10_000),
}).strict().superRefine((library, context) => {
  const entries = new Map<string, MediaEntry>();
  const historyIds = new Set<string>();
  let historyCount = 0;
  library.entries.forEach((entry, index) => {
    if (entries.has(entry.id)) context.addIssue({ code: "custom", path: ["entries", index, "id"], message: "影音作品存在重复编号。" });
    entries.set(entry.id, entry);
    for (const event of entry.history) {
      if (historyIds.has(event.id)) context.addIssue({ code: "custom", path: ["entries", index, "history"], message: "观看记录存在重复编号。" });
      historyIds.add(event.id);
      historyCount += 1;
    }
  });
  if (historyCount > 50_000) context.addIssue({ code: "custom", path: ["entries"], message: "最多保存 50,000 次真实观看记录，请先导出备份并整理数据。" });
  library.entries.forEach((entry, index) => {
    // An episode-only import is valid; if its parent is present it must be a show.
    if (entry.showId && entries.has(entry.showId) && entries.get(entry.showId)?.kind !== "show") {
      context.addIssue({ code: "custom", path: ["entries", index, "showId"], message: "单集所属作品必须是剧集。" });
    }
  });
});
export type MediaLibrary = z.infer<typeof mediaLibrarySchema>;

export function emptyMediaLibrary(): MediaLibrary {
  return { version: 1, source: "manual", syncedAt: null, entries: [] };
}

export class MediaImportError extends Error {
  constructor(message: string) { super(message); this.name = "MediaImportError"; }
}

/** Validate portable media JSON without retaining or echoing unsupported credential fields. */
export function parseMediaImport(input: string | unknown): MediaLibrary {
  let value: unknown = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_MEDIA_IMPORT_BYTES) throw new MediaImportError("影音文件过大，请分批导入。");
    try { value = JSON.parse(input); }
    catch { throw new MediaImportError("影音文件必须是完整的 JSON。"); }
  }
  const result = mediaLibrarySchema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {
    version: "格式版本", source: "来源", syncedAt: "同步日期", entries: "影音作品", id: "编号", kind: "作品类型",
    title: "片名", year: "年份", genres: "类型", status: "观看状态", rating: "评分", history: "观看记录", watchedAt: "观看日期",
    traktId: "Trakt 编号", traktUrl: "Trakt 链接", poster: "海报地址", showId: "所属剧集", season: "季编号", episode: "集编号", thought: "感想",
  };
  const errors = result.error.issues.slice(0, 4).map(issue => {
    const path = issue.path.map(part => typeof part === "number" ? `第 ${part + 1} 项` : fields[String(part)] ?? "字段").join(" / ");
    const message = issue.code === "custom" ? issue.message : issue.code === "unrecognized_keys" ? "包含不支持的字段" : "字段缺失或格式不正确";
    return `${path || "影音文件"}：${message}`;
  });
  throw new MediaImportError(errors.join("；"));
}

/** Imported metadata updates matching titles while preserving personal thoughts and real viewing events. */
export function mergeMediaLibraries(existing: MediaLibrary, incoming: MediaLibrary): MediaLibrary {
  const records = new Map(existing.entries.map(entry => [entry.id, entry]));
  for (const entry of incoming.entries) {
    const previous = records.get(entry.id);
    if (previous && previous.kind !== entry.kind) throw new MediaImportError("作品编号对应不同的影音类型，未导入任何内容。");
    const history = new Map((previous?.history ?? []).map(event => [event.id, event]));
    for (const event of entry.history) {
      const before = history.get(event.id);
      if (before && before.watchedAt !== event.watchedAt) throw new MediaImportError("观看记录编号对应不同日期，未导入任何内容。请保留原文件后核对。");
      history.set(event.id, event);
    }
    // A rating or an episode's parent show does not establish a watch state.
    // Retain an existing classification when the import provides none.
    const status = entry.status === "unclassified" && previous ? previous.status : entry.status;
    records.set(entry.id, { ...previous, ...entry, status, history: [...history.values()] });
  }
  return mediaLibrarySchema.parse({
    version: 1, source: incoming.source, syncedAt: incoming.syncedAt ?? existing.syncedAt, entries: [...records.values()],
  });
}
