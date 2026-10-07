import { chinaToday } from "./dates";
import { readingLibrarySchema } from "./reading";
import type { ReadingBook, ReadingHighlight, ReadingLibrary } from "./reading";
import {
  normalizeHighlights, normalizeNotebooks, normalizeShelf, normalizeStats, normalizeThoughts, unwrapWeReadResponse,
} from "./weread";
import type { ReadingNotebook, WeReadClient } from "./weread";

export const WEREAD_SYNC_LIMITS = { notebookBooks: 80, notes: 10_000 } as const;
const PAGE_SIZE = 20;
// Every continuing page must add at least one unique item; the content limit is the real bound.
const MAX_PAGES = WEREAD_SYNC_LIMITS.notes + 1;

export class WeReadSyncError extends Error {
  constructor(public readonly code: "LimitExceeded" | "PaginationError" | "InvalidData", message: string) {
    super(message);
    this.name = "WeReadSyncError";
  }
}

export interface WeReadSyncProgress {
  stage: "shelf" | "stats" | "notebooks" | "notes" | "complete";
  message: string;
  completed?: number;
  total?: number;
}

export interface WeReadSyncOptions {
  now?: Date;
  includeNotes?: boolean;
  onProgress?: (progress: WeReadSyncProgress) => void;
}

export type WeReadSyncClient = Pick<WeReadClient, "shelf" | "stats" | "notebooks" | "highlights" | "thoughts">;

function invalidData(): never {
  throw new WeReadSyncError("InvalidData", "微信读书返回的数据暂时无法完整整理，未保存本次读取结果。请改用 JSON 导入。");
}
function paginationError(): never {
  throw new WeReadSyncError("PaginationError", "微信读书的分页没有继续前进，已停止读取，未保存不完整结果。请稍后重试或改用 JSON 导入。");
}
function booksLimit(): never {
  throw new WeReadSyncError("LimitExceeded", "本次临时连接最多读取 80 本有笔记的书。已停止读取，未保存不完整结果；可取消勾选笔记，仅获取书架和统计，或改用 JSON 导入。");
}
function notesLimit(): never {
  throw new WeReadSyncError("LimitExceeded", "本次临时连接最多读取 10000 条划线与想法。已停止读取，未保存不完整结果；可取消勾选笔记，仅获取书架和统计，或改用 JSON 导入。");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** readLongest.readTime is documented in seconds, within the requested overall period. */
function retainRankedBooks(response: unknown, books: Map<string, ReadingBook>): void {
  const payload = unwrapWeReadResponse(response);
  if (payload.readLongest === undefined) return;
  if (!Array.isArray(payload.readLongest)) return invalidData();
  for (const value of payload.readLongest) {
    const item = record(value);
    if (!item || typeof item.readTime !== "number" || !Number.isFinite(item.readTime) || item.readTime < 0) return invalidData();
    const book = record(item.book);
    const album = record(item.albumInfo);
    if (!book && !album) return invalidData();
    const normalized = normalizeShelf({ books: book ? [book] : [], albums: !book && album ? [{ albumInfo: album }] : [] });
    for (const entry of normalized) {
      const existing = books.get(entry.id);
      const existingFields = Object.fromEntries(Object.entries(existing ?? {}).filter(([, value]) => value !== undefined));
      books.set(entry.id, { ...entry, ...existingFields,
        status: existing?.status === "finished" ? "finished" : item.readTime > 0 ? "reading" : existing?.status ?? entry.status,
        secondsRead: item.readTime });
    }
  }
}

/**
 * Build one reviewable snapshot using only documented read-only requests.
 * Requests stay sequential so an upgrade requirement halts the workflow immediately.
 * Nothing is persisted by this function; any error discards its partial in-memory result.
 */
export async function fetchWeReadLibrary(client: WeReadSyncClient, options: WeReadSyncOptions = {}): Promise<ReadingLibrary> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return invalidData();
  const currentYear = chinaToday(now).slice(0, 4);
  // The API documents a timestamp within the year, without specifying its period timezone.
  // A date well inside the selected Shanghai year also belongs to that year in other timezones.
  const annualBaseTime = Math.floor(Date.UTC(Number(currentYear), 0, 15, 12) / 1_000);
  const report = options.onProgress ?? (() => {});

  report({ stage: "shelf", message: "正在取回书架…" });
  const shelf = normalizeShelf(await client.shelf());
  const books = new Map(shelf.map(book => [book.id, book]));
  if (books.size !== shelf.length) return invalidData();

  report({ stage: "stats", message: "正在取回累计统计与今年的每日阅读…" });
  const overallResponse = await client.stats("overall", 0);
  const overall = normalizeStats(overallResponse, "overall");
  if (!overall) return invalidData();
  retainRankedBooks(overallResponse, books);
  const annual = normalizeStats(await client.stats("annually", annualBaseTime), "annually");
  if (!annual || annual.dailySeconds.some(day => !day.date.startsWith(`${currentYear}-`))) return invalidData();
  // Preserve the authoritative overall total, while using only explicit daily buckets for the calendar.
  const stats = { ...overall, dailySeconds: annual.dailySeconds };
  const notes = new Map<string, ReadingHighlight>();

  if (options.includeNotes !== false) {
    report({ stage: "notebooks", message: "正在取回笔记本目录…" });
    const notebooks = new Map<string, ReadingNotebook>();
    const notebookCursors = new Set<number>();
    let lastSort: number | undefined;
    let notebookPages = 0;
    let expectedNotebookCount: number | undefined;
    for (;;) {
      if (++notebookPages > MAX_PAGES) return paginationError();
      const page = normalizeNotebooks(await client.notebooks(PAGE_SIZE, lastSort));
      if (page.totalBookCount !== undefined && page.totalBookCount > WEREAD_SYNC_LIMITS.notebookBooks) return booksLimit();
      if (page.totalBookCount !== undefined) {
        if (expectedNotebookCount !== undefined && expectedNotebookCount !== page.totalBookCount) return invalidData();
        expectedNotebookCount = page.totalBookCount;
      }
      for (const notebook of page.books) {
        if (notebooks.has(notebook.book.id)) return paginationError();
        notebooks.set(notebook.book.id, notebook);
        if (notebooks.size > WEREAD_SYNC_LIMITS.notebookBooks) return booksLimit();
        if (!books.has(notebook.book.id)) books.set(notebook.book.id, notebook.book);
      }
      if (!page.hasMore) break;
      if (!page.books.length || page.nextLastSort === undefined || notebookCursors.has(page.nextLastSort)) return paginationError();
      notebookCursors.add(page.nextLastSort);
      lastSort = page.nextLastSort;
    }
    if (expectedNotebookCount !== undefined && notebooks.size !== expectedNotebookCount) return invalidData();

    const estimatedExportableNotes = [...notebooks.values()].reduce((total, notebook) => total + (notebook.highlightCount ?? 0) + (notebook.thoughtCount ?? 0), 0);
    // Bookmark counts never count against a content limit: the API cannot export bookmark contents.
    if (estimatedExportableNotes > WEREAD_SYNC_LIMITS.notes) return notesLimit();
    let completed = 0;
    const addNotes = (items: ReadingHighlight[], bookId: string) => {
      for (const item of items) {
        if (item.bookId !== bookId) return invalidData();
        if (notes.has(item.id)) return paginationError();
        notes.set(item.id, item);
        if (notes.size > WEREAD_SYNC_LIMITS.notes) return notesLimit();
      }
    };
    for (const notebook of notebooks.values()) {
      const bookId = notebook.book.id;
      report({ stage: "notes", message: `正在取回划线与想法（${completed + 1}/${notebooks.size}）…`, completed, total: notebooks.size });
      // /book/bookmarklist has no documented pagination parameters.
      const highlights = normalizeHighlights(await client.highlights(bookId), bookId);
      addNotes(highlights, bookId);
      if (notebook.highlightCount !== undefined && highlights.length !== notebook.highlightCount) return invalidData();
      const thoughtCursors = new Set<number>([0]);
      let synckey: number | undefined;
      let thoughtPages = 0;
      let thoughtCount = 0;
      let expectedThoughtCount: number | undefined;
      for (;;) {
        if (++thoughtPages > MAX_PAGES) return paginationError();
        const page = normalizeThoughts(await client.thoughts(bookId, { count: PAGE_SIZE, ...(synckey === undefined ? {} : { synckey }) }), bookId);
        if (page.totalCount !== undefined && page.totalCount > WEREAD_SYNC_LIMITS.notes) return notesLimit();
        if (page.totalCount !== undefined) {
          if (expectedThoughtCount !== undefined && expectedThoughtCount !== page.totalCount) return invalidData();
          expectedThoughtCount = page.totalCount;
        }
        addNotes(page.highlights, bookId);
        thoughtCount += page.highlights.length;
        if (!page.hasMore) break;
        if (!page.highlights.length || page.nextSynckey === undefined || thoughtCursors.has(page.nextSynckey)) return paginationError();
        thoughtCursors.add(page.nextSynckey);
        synckey = page.nextSynckey;
      }
      if ((expectedThoughtCount !== undefined && thoughtCount !== expectedThoughtCount)
        || (notebook.thoughtCount !== undefined && thoughtCount !== notebook.thoughtCount)) return invalidData();
      completed += 1;
    }
  }

  const result = readingLibrarySchema.safeParse({ version: 1, source: "weread", books: [...books.values()], highlights: [...notes.values()], stats, syncedAt: now.toISOString() });
  if (!result.success) return invalidData();
  report({ stage: "complete", message: "已取回阅读数据，请先查看预览。" });
  return result.data;
}
