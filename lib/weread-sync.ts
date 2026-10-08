import { chinaToday } from "./dates";
import { readingLibrarySchema } from "./reading";
import type { ReadingBook, ReadingHighlight, ReadingLibrary } from "./reading";
import {
  normalizeHighlights, normalizeNotebooks, normalizeShelf, normalizeStats, normalizeThoughts, unwrapWeReadResponse,
} from "./weread";
import type { ReadingNotebook, WeReadClient } from "./weread";

export const WEREAD_SYNC_LIMITS = { notebookBooks: 1_000, notes: 10_000 } as const;
const NOTEBOOK_PAGE_SIZE = 20;
const THOUGHT_PAGE_SIZE = 100;
// Every continuing page must add at least one unique item; the content limit is the real bound.
const MAX_PAGES = WEREAD_SYNC_LIMITS.notes + 1;

/** Only fixed structural reasons may appear in synchronization diagnostics. */
export const WEREAD_SYNC_REASONS = [
  "invalid_sync_date", "ranking_not_array", "ranking_entry_invalid", "ranking_book_missing",
  "duplicate_shelf_ids", "overall_total_missing", "annual_total_missing", "annual_wrong_year",
  "notebook_page_limit", "notebook_total_changed", "duplicate_notebook_ids",
  "notebook_empty_continuation", "notebook_cursor_missing", "notebook_cursor_repeated",
  "notebook_total_shortfall", "note_book_mismatch", "duplicate_note_ids", "highlight_count_mismatch",
  "thought_page_limit", "thought_total_changed", "thought_empty_continuation",
  "thought_cursor_missing", "thought_cursor_repeated", "thought_total_shortfall",
  "thought_total_zero_with_content", "thought_total_excess",
  "thought_notebook_count_mismatch", "library_schema_invalid",
] as const;
export type WeReadSyncReason = (typeof WEREAD_SYNC_REASONS)[number];

export class WeReadSyncError extends Error {
  constructor(public readonly code: "LimitExceeded" | "PaginationError" | "InvalidData", message: string,
    public readonly limitKind?: "notebooks" | "notes", public readonly reason?: WeReadSyncReason) {
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

function invalidData(reason: WeReadSyncReason): never {
  throw new WeReadSyncError("InvalidData", "微信读书返回的数据暂时无法完整整理，未保存本次读取结果。请改用 JSON 导入。", undefined, reason);
}
function paginationError(reason: WeReadSyncReason): never {
  throw new WeReadSyncError("PaginationError", "微信读书的分页没有继续前进，已停止读取，未保存不完整结果。请稍后重试或改用 JSON 导入。", undefined, reason);
}
function booksLimit(): never {
  throw new WeReadSyncError("LimitExceeded", "本次同步最多读取 1000 本有笔记的书。已停止读取，未保存不完整结果；可先仅同步书架和统计，或改用 JSON 导入。", "notebooks");
}
function notesLimit(): never {
  throw new WeReadSyncError("LimitExceeded", "本次同步最多读取 10000 条划线与想法。已停止读取，未保存不完整结果；可先仅同步书架和统计，或改用 JSON 导入。", "notes");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** readLongest.readTime is documented in seconds, within the requested overall period. */
function retainRankedBooks(response: unknown, books: Map<string, ReadingBook>): void {
  const payload = unwrapWeReadResponse(response);
  if (payload.readLongest === undefined) return;
  if (!Array.isArray(payload.readLongest)) return invalidData("ranking_not_array");
  for (const value of payload.readLongest) {
    const item = record(value);
    if (!item || typeof item.readTime !== "number" || !Number.isFinite(item.readTime) || item.readTime < 0) return invalidData("ranking_entry_invalid");
    const book = record(item.book);
    const album = record(item.albumInfo);
    if (!book && !album) return invalidData("ranking_book_missing");
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
  if (!Number.isFinite(now.getTime())) return invalidData("invalid_sync_date");
  const currentYear = chinaToday(now).slice(0, 4);
  // The API documents a timestamp within the year, without specifying its period timezone.
  // A date well inside the selected Shanghai year also belongs to that year in other timezones.
  const annualBaseTime = Math.floor(Date.UTC(Number(currentYear), 0, 15, 12) / 1_000);
  const report = options.onProgress ?? (() => {});

  report({ stage: "shelf", message: "正在取回书架…" });
  const shelf = normalizeShelf(await client.shelf());
  const books = new Map(shelf.map(book => [book.id, book]));
  if (books.size !== shelf.length) return invalidData("duplicate_shelf_ids");

  report({ stage: "stats", message: "正在取回累计统计与今年的每日阅读…" });
  const overallResponse = await client.stats("overall", 0);
  const overall = normalizeStats(overallResponse, "overall");
  if (!overall) return invalidData("overall_total_missing");
  retainRankedBooks(overallResponse, books);
  const annual = normalizeStats(await client.stats("annually", annualBaseTime), "annually");
  if (!annual) return invalidData("annual_total_missing");
  if (annual.dailySeconds.some(day => !day.date.startsWith(`${currentYear}-`))) return invalidData("annual_wrong_year");
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
      if (++notebookPages > MAX_PAGES) return paginationError("notebook_page_limit");
      const page = normalizeNotebooks(await client.notebooks(NOTEBOOK_PAGE_SIZE, lastSort));
      if (page.totalBookCount !== undefined && page.totalBookCount > WEREAD_SYNC_LIMITS.notebookBooks) return booksLimit();
      if (page.totalBookCount !== undefined) {
        if (expectedNotebookCount !== undefined && expectedNotebookCount !== page.totalBookCount) return invalidData("notebook_total_changed");
        expectedNotebookCount = page.totalBookCount;
      }
      for (const notebook of page.books) {
        if (notebooks.has(notebook.book.id)) return paginationError("duplicate_notebook_ids");
        notebooks.set(notebook.book.id, notebook);
        if (notebooks.size > WEREAD_SYNC_LIMITS.notebookBooks) return booksLimit();
        if (!books.has(notebook.book.id)) books.set(notebook.book.id, notebook.book);
      }
      if (!page.hasMore) break;
      if (!page.books.length) return paginationError("notebook_empty_continuation");
      if (page.nextLastSort === undefined) return paginationError("notebook_cursor_missing");
      if (notebookCursors.has(page.nextLastSort)) return paginationError("notebook_cursor_repeated");
      notebookCursors.add(page.nextLastSort);
      lastSort = page.nextLastSort;
    }
    if (expectedNotebookCount !== undefined && notebooks.size !== expectedNotebookCount) return invalidData("notebook_total_shortfall");

    const estimatedExportableNotes = [...notebooks.values()].reduce((total, notebook) => total + (notebook.highlightCount ?? 0) + (notebook.thoughtCount ?? 0), 0);
    // Bookmark counts never count against a content limit: the API cannot export bookmark contents.
    if (estimatedExportableNotes > WEREAD_SYNC_LIMITS.notes) return notesLimit();
    let completed = 0;
    const addNotes = (items: ReadingHighlight[], bookId: string) => {
      for (const item of items) {
        if (item.bookId !== bookId) return invalidData("note_book_mismatch");
        if (notes.has(item.id)) return paginationError("duplicate_note_ids");
        notes.set(item.id, item);
        if (notes.size > WEREAD_SYNC_LIMITS.notes) return notesLimit();
      }
    };
    for (const notebook of notebooks.values()) {
      const bookId = notebook.book.id;
      report({ stage: "notes", message: `正在取回划线与想法（${completed + 1}/${notebooks.size}）…`, completed, total: notebooks.size });
      // /book/bookmarklist has no documented pagination parameters.
      // The notebook's documented zero counts permit skipping an empty content
      // request. Missing counts are unknown, so they must still be queried.
      if (notebook.highlightCount !== 0) {
        const highlights = normalizeHighlights(await client.highlights(bookId), bookId);
        addNotes(highlights, bookId);
        if (notebook.highlightCount !== undefined && highlights.length !== notebook.highlightCount) return invalidData("highlight_count_mismatch");
      }
      if (notebook.thoughtCount !== 0) {
        const thoughtCursors = new Set<number>([0]);
        let synckey = 0;
        let thoughtPages = 0;
        let thoughtCount = 0;
        let expectedThoughtCount: number | undefined;
        for (;;) {
          if (++thoughtPages > MAX_PAGES) return paginationError("thought_page_limit");
          const page = normalizeThoughts(await client.thoughts(bookId, { count: THOUGHT_PAGE_SIZE, synckey }), bookId);
          if (page.totalCount !== undefined && page.totalCount > WEREAD_SYNC_LIMITS.notes) return notesLimit();
          if (page.totalCount !== undefined) {
            if (expectedThoughtCount !== undefined && expectedThoughtCount !== page.totalCount) return invalidData("thought_total_changed");
            expectedThoughtCount = page.totalCount;
          }
          addNotes(page.highlights, bookId);
          thoughtCount += page.highlights.length;
          if (!page.hasMore) break;
          if (!page.highlights.length) return paginationError("thought_empty_continuation");
          if (page.nextSynckey === undefined) return paginationError("thought_cursor_missing");
          if (thoughtCursors.has(page.nextSynckey)) return paginationError("thought_cursor_repeated");
          thoughtCursors.add(page.nextSynckey);
          synckey = page.nextSynckey;
        }
        if (expectedThoughtCount === 0 && thoughtCount > 0) return invalidData("thought_total_zero_with_content");
        if (expectedThoughtCount !== undefined && thoughtCount > expectedThoughtCount) return invalidData("thought_total_excess");
        if (expectedThoughtCount !== undefined && thoughtCount < expectedThoughtCount) return invalidData("thought_total_shortfall");
        if (notebook.thoughtCount !== undefined && thoughtCount !== notebook.thoughtCount) return invalidData("thought_notebook_count_mismatch");
      }
      completed += 1;
    }
  }

  const result = readingLibrarySchema.safeParse({ version: 1, source: "weread", books: [...books.values()], highlights: [...notes.values()], stats, syncedAt: now.toISOString() });
  if (!result.success) return invalidData("library_schema_invalid");
  report({ stage: "complete", message: "已取回阅读数据，请先查看预览。" });
  return result.data;
}
