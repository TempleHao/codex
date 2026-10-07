import { chinaToday } from "./dates";
import { isSafeReadingLink, readingBookSchema, readingHighlightSchema, readingStatsSchema } from "./reading";
import type { ReadingBook, ReadingHighlight, ReadingMode, ReadingStats } from "./reading";

export const WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
export const WEREAD_SKILL_VERSION = "1.0.4";

type ErrorCode = "InvalidInput" | "NetworkError" | "Timeout" | "HttpError" | "BusinessError" | "InvalidResponse" | "UpgradeRequired";
export class WeReadError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = "WeReadError"; }
}
export class UpgradeRequired extends WeReadError {
  constructor() {
    super("UpgradeRequired", "微信读书接口要求升级技能。请更新官方微信读书技能后重新连接，当前操作已暂停。");
    this.name = "UpgradeRequired";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function invalidResponse(): never { throw new WeReadError("InvalidResponse", "微信读书返回的数据格式暂不支持，请保留已有阅读记录。"); }
function inspectGateway(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, "upgrade_info")) throw new UpgradeRequired();
  if (Object.hasOwn(value, "errcode") && value.errcode !== 0) {
    throw new WeReadError("BusinessError", "微信读书暂时无法返回数据，请检查连接后重试。");
  }
}

/** Limited compatibility: a direct documented payload or one object-valued data envelope. */
export function unwrapWeReadResponse(value: unknown): Record<string, unknown> {
  const outer = record(value);
  if (!outer) return invalidResponse();
  inspectGateway(outer);
  if (Object.hasOwn(outer, "data")) {
    const inner = record(outer.data);
    if (!inner) return invalidResponse();
    inspectGateway(inner);
    return inner;
  }
  return outer;
}

export interface WeReadClientOptions {
  /** Runtime-only authentication; never put this value in localStorage or exported JSON. */
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Read-only official gateway adapter. No requests run until a method is called. */
export class WeReadClient {
  #token: string;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #upgradeRequired = false;
  #active = new Set<AbortController>();

  constructor({ token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 }: WeReadClientOptions) {
    if (!token.trim() || /[\r\n]/.test(token) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new WeReadError("InvalidInput", "连接参数无效，请检查后重试。");
    }
    this.#token = token;
    // Browser fetch requires its global receiver; a private-member call otherwise
    // binds this to WeReadClient and can fail before any request reaches the network.
    this.#fetch = fetchImpl.bind(globalThis);
    this.#timeoutMs = timeoutMs;
  }

  disconnect(): void {
    this.#token = "";
    this.#active.forEach(controller => controller.abort());
  }

  async #request(apiName: string, parameters: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    if (this.#upgradeRequired) throw new UpgradeRequired();
    if (!this.#token) throw new WeReadError("InvalidInput", "当前连接已关闭，请重新连接。");
    const controller = new AbortController();
    this.#active.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      const response = await this.#fetch(WEREAD_GATEWAY, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...parameters, api_name: apiName, skill_version: WEREAD_SKILL_VERSION }),
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (this.#upgradeRequired) throw new UpgradeRequired();
      if (timedOut) throw new WeReadError("Timeout", "微信读书请求超时，请稍后重试。");
      // Inspect every JSON response for upgrade_info, including non-2xx responses.
      let body: unknown;
      try { body = await response.json(); }
      catch { if (response.ok) return invalidResponse(); }
      const outer = record(body);
      if (outer) {
        if (Object.hasOwn(outer, "upgrade_info") || (record(outer.data) && Object.hasOwn(record(outer.data)!, "upgrade_info"))) {
          throw new UpgradeRequired();
        }
      }
      if (!response.ok) throw new WeReadError("HttpError", response.status === 401 || response.status === 403
        ? "微信读书连接未通过验证，请检查授权后重试。"
        : "微信读书服务暂时不可用，请稍后重试。");
      const payload = unwrapWeReadResponse(body);
      if (this.#upgradeRequired) throw new UpgradeRequired();
      if (timedOut) throw new WeReadError("Timeout", "微信读书请求超时，请稍后重试。");
      if (!this.#token) throw new WeReadError("InvalidInput", "当前连接已关闭，请重新连接。");
      return payload;
    } catch (error) {
      if (error instanceof UpgradeRequired || this.#upgradeRequired) {
        this.#upgradeRequired = true;
        this.#active.forEach(active => active.abort());
        throw new UpgradeRequired();
      }
      if (timedOut) throw new WeReadError("Timeout", "微信读书请求超时，请稍后重试。");
      if (error instanceof WeReadError) throw error;
      // Neither raw gateway messages nor fetch errors are reflected or logged.
      throw new WeReadError("NetworkError", "暂时无法连接微信读书，请检查网络或通过 JSON 导入阅读数据。");
    } finally { clearTimeout(timeout); this.#active.delete(controller); }
  }

  shelf() { return this.#request("/shelf/sync"); }
  stats(mode: ReadingMode = "monthly", baseTime?: number) {
    if (!["weekly", "monthly", "annually", "overall"].includes(mode)) throw new WeReadError("InvalidInput", "请选择有效的统计周期。");
    if (baseTime !== undefined) requireInteger(baseTime);
    return this.#request("/readdata/detail", { mode, ...(mode === "overall" ? { baseTime: 0 } : baseTime === undefined ? {} : { baseTime }) });
  }
  notebooks(count = 20, lastSort?: number) {
    requireInteger(count, true);
    if (lastSort !== undefined) requireInteger(lastSort);
    return this.#request("/user/notebooks", { count, ...(lastSort === undefined ? {} : { lastSort }) });
  }
  bookProgress(bookId: string) { return this.#request("/book/getprogress", { bookId: requireText(bookId) }); }
  highlights(bookId: string) { return this.#request("/book/bookmarklist", { bookId: requireText(bookId) }); }
  thoughts(bookId: string, options: { count?: number; synckey?: number } = {}) {
    if (options.count !== undefined) requireInteger(options.count, true);
    if (options.synckey !== undefined) requireInteger(options.synckey);
    return this.#request("/review/list/mine", { bookid: requireText(bookId),
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.synckey === undefined ? {} : { synckey: options.synckey }) });
  }
  /** The reading UI searches for books, so it explicitly selects scope=10. */
  search(keyword: string, options: { scope?: 0 | 10 | 16 | 14 | 6 | 12 | 13 | 2 | 4; count?: number; maxIdx?: number } = {}) {
    const scope = options.scope ?? 10;
    if (![0, 10, 16, 14, 6, 12, 13, 2, 4].includes(scope)) throw new WeReadError("InvalidInput", "请选择有效的搜索类型。");
    if (options.count !== undefined) requireInteger(options.count, true);
    if (options.maxIdx !== undefined) requireInteger(options.maxIdx);
    return this.#request("/store/search", { keyword: requireText(keyword), scope,
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.maxIdx === undefined ? {} : { maxIdx: options.maxIdx }) });
  }
}

function requireInteger(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new WeReadError("InvalidInput", "请求数字参数无效。");
}
function requireText(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) throw new WeReadError("InvalidInput", "请填写有效的书籍编号或搜索词。");
  return value.trim();
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function id(value: unknown): string | undefined { return text(value) ?? (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined); }
function seconds(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function unixDate(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? chinaToday(date) : undefined;
}
function deepLink(value: unknown): string | undefined { return typeof value === "string" && isSafeReadingLink(value) ? value : undefined; }
function cover(value: unknown): string | undefined { return deepLink(value)?.startsWith("https://") ? value as string : undefined; }
function array(value: unknown): unknown[] { if (value === undefined) return []; return Array.isArray(value) ? value : invalidResponse(); }
function parseBook(value: unknown): ReadingBook {
  const result = readingBookSchema.safeParse(value);
  return result.success ? result.data : invalidResponse();
}
function nonempty(value: unknown): boolean {
  const item = record(value);
  return item !== null && Object.keys(item).length > 0;
}

export function normalizeShelf(response: unknown): ReadingBook[] {
  const payload = unwrapWeReadResponse(response);
  if (!["books", "albums", "mp"].some(key => Object.hasOwn(payload, key))) return invalidResponse();
  const books = array(payload.books).map(value => {
    const book = record(value);
    if (!book) return invalidResponse();
    const lastReadAt = unixDate(book.readUpdateTime);
    const finished = book.finishReading === 1;
    return parseBook({ id: id(book.bookId), title: text(book.title), author: text(book.author) ?? "", kind: "ebook",
      status: finished ? "finished" : lastReadAt ? "reading" : "wanted", finished,
      cover: cover(book.cover), deepLink: deepLink(book.deepLink), lastReadAt });
  });
  const albums = array(payload.albums).map(value => {
    const album = record(value);
    const info = record(album?.albumInfo);
    if (!info || !id(info.albumId)) return invalidResponse();
    const extra = record(album?.albumInfoExtra);
    const lastReadAt = unixDate(extra?.lectureReadUpdateTime);
    // albumInfo.finish describes the published series, never the reader's completion.
    return parseBook({ id: `album:${id(info.albumId)}`, title: text(info.name), author: text(info.authorName) ?? "", kind: "audiobook",
      status: lastReadAt ? "reading" : "wanted", cover: cover(info.cover), deepLink: deepLink(info.deepLink ?? album?.deepLink), lastReadAt });
  });
  const articles: ReadingBook[] = nonempty(payload.mp) ? [{
    id: "weread:articles", title: "文章收藏", author: "", kind: "article", status: "wanted",
    ...(deepLink(record(payload.mp)?.deepLink) ? { deepLink: deepLink(record(payload.mp)?.deepLink) } : {}),
  }] : [];
  return [...books, ...albums, ...articles];
}

export function normalizeBookProgress(response: unknown): Partial<ReadingBook> {
  const payload = unwrapWeReadResponse(response);
  const book = record(payload.book);
  if (!book || typeof book.progress !== "number" || !Number.isInteger(book.progress) || book.progress < 0 || book.progress > 100) return invalidResponse();
  const finished = book.progress === 100 && unixDate(book.finishTime) !== undefined;
  return { progress: book.progress, finished,
    status: finished ? "finished" : book.progress > 0 || book.isStartReading === 1 ? "reading" : "wanted",
    lastReadAt: unixDate(book.updateTime), secondsRead: seconds(book.recordReadingTime) };
}

function dailyBuckets(value: unknown): ReadingStats["dailySeconds"] {
  if (value === undefined) return [];
  const buckets = record(value);
  if (!buckets) return invalidResponse();
  const days = new Map<string, number>();
  for (const [timestamp, amount] of Object.entries(buckets)) {
    if (!/^\d+$/.test(timestamp)) return invalidResponse();
    const date = unixDate(Number(timestamp));
    const duration = seconds(amount);
    if (!date || duration === undefined) return invalidResponse();
    days.set(date, (days.get(date) ?? 0) + duration);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
}

export function normalizeStats(response: unknown, mode: ReadingMode = "monthly"): ReadingStats | null {
  const payload = unwrapWeReadResponse(response);
  const totalSeconds = seconds(payload.totalReadTime);
  if (totalSeconds === undefined) return null;
  const readingDays = typeof payload.readDays === "number" && Number.isSafeInteger(payload.readDays) && payload.readDays >= 0 ? payload.readDays : undefined;
  const baseTime = typeof payload.baseTime === "number" && Number.isSafeInteger(payload.baseTime) && payload.baseTime >= 0 ? payload.baseTime : undefined;
  // yearly/overall readTimes are month/year buckets, so they cannot populate a daily calendar.
  const dailySeconds = dailyBuckets(payload.dailyReadTimes ?? (mode === "monthly" || mode === "weekly" ? payload.readTimes : undefined));
  let preferredHours: ReadingStats["preferredHours"];
  if (Array.isArray(payload.preferTime) && payload.preferTime.length === 24 && payload.preferTime.every(value => seconds(value) !== undefined)) {
    preferredHours = payload.preferTime.map((duration, index) => ({ hour: (index + 6) % 24, seconds: duration as number }));
  }
  const result = readingStatsSchema.safeParse({ totalSeconds, readingDays, dailySeconds, mode,
    period: baseTime === undefined ? null : { start: unixDate(baseTime) ?? null, baseTime }, preferredHours });
  return result.success ? result.data : invalidResponse();
}

export interface ReadingNotebook {
  book: ReadingBook;
  highlightCount?: number;
  thoughtCount?: number;
  bookmarkCount?: number;
  totalNoteCount?: number;
  sort?: number;
}
export interface NotebookPage {
  books: ReadingNotebook[];
  hasMore: boolean;
  nextLastSort?: number;
  totalBookCount?: number;
  totalNoteCount?: number;
}
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }

export function normalizeNotebooks(response: unknown): NotebookPage {
  const payload = unwrapWeReadResponse(response);
  if (!Array.isArray(payload.books)) return invalidResponse();
  const books: ReadingNotebook[] = payload.books.map(value => {
    const item = record(value);
    const book = record(item?.book);
    if (!item || !book) return invalidResponse();
    const highlightCount = count(item.noteCount);
    const thoughtCount = count(item.reviewCount);
    const bookmarkCount = count(item.bookmarkCount);
    // readingProgress has no documented unit; fetch bookProgress before showing a percentage.
    return { book: parseBook({ id: id(item.bookId), title: text(book.title), author: text(book.author) ?? "", kind: "ebook",
      status: item.markedStatus === 1 ? "finished" : "reading", finished: item.markedStatus === 1,
      cover: cover(book.cover), deepLink: deepLink(book.deepLink) }),
      highlightCount, thoughtCount, bookmarkCount,
      totalNoteCount: highlightCount === undefined || thoughtCount === undefined || bookmarkCount === undefined ? undefined : highlightCount + thoughtCount + bookmarkCount,
      sort: count(item.sort) };
  });
  const hasMore = payload.hasMore === 1;
  const nextLastSort = hasMore ? books.at(-1)?.sort : undefined;
  if (hasMore && nextLastSort === undefined) return invalidResponse();
  return { books, hasMore, nextLastSort, totalBookCount: count(payload.totalBookCount), totalNoteCount: count(payload.totalNoteCount) };
}

export const normalizeNotebook = normalizeNotebooks;

function parseHighlight(value: unknown): ReadingHighlight {
  const result = readingHighlightSchema.safeParse(value);
  return result.success ? result.data : invalidResponse();
}
export function normalizeHighlights(response: unknown, bookId: string): ReadingHighlight[] {
  requireText(bookId);
  const payload = unwrapWeReadResponse(response);
  if (!Array.isArray(payload.updated)) return invalidResponse();
  const chapters = new Map(array(payload.chapters).map(value => {
    const chapter = record(value);
    return [id(chapter?.chapterUid), text(chapter?.title)] as const;
  }));
  return payload.updated.filter(value => record(value)?.type !== 0).map(value => {
    const item = record(value);
    if (!item) return invalidResponse();
    return parseHighlight({ id: id(item.bookmarkId), bookId: id(item.bookId) ?? bookId, text: text(item.markText) ?? "",
      chapter: chapters.get(id(item.chapterUid)), createdAt: unixDate(item.createTime), deepLink: deepLink(item.deepLink) });
  });
}

export interface ThoughtsPage { highlights: ReadingHighlight[]; hasMore: boolean; nextSynckey?: number; totalCount?: number; }
export function normalizeThoughts(response: unknown, bookId: string): ThoughtsPage {
  requireText(bookId);
  const payload = unwrapWeReadResponse(response);
  if (!Array.isArray(payload.reviews)) return invalidResponse();
  const highlights = payload.reviews.map(value => {
    const wrapper = record(value);
    const review = record(wrapper?.review);
    if (!review || !id(review.reviewId)) return invalidResponse();
    return parseHighlight({ id: `review:${id(review.reviewId)}`, bookId, text: text(review.abstract) ?? "", thought: text(review.content),
      chapter: text(review.chapterName), createdAt: unixDate(review.createTime), deepLink: deepLink(review.deepLink ?? wrapper?.deepLink) });
  });
  const hasMore = payload.hasMore === 1;
  const nextSynckey = hasMore ? count(payload.synckey) : undefined;
  if (hasMore && nextSynckey === undefined) return invalidResponse();
  return { highlights, hasMore, nextSynckey, totalCount: count(payload.totalCount) };
}

export interface SearchPage { books: ReadingBook[]; hasMore: boolean; nextMaxIdx?: number; }
export function normalizeSearch(response: unknown): SearchPage {
  const payload = unwrapWeReadResponse(response);
  if (!Array.isArray(payload.results)) return invalidResponse();
  const books: ReadingBook[] = [];
  let nextMaxIdx: number | undefined;
  for (const group of payload.results) {
    const result = record(group);
    if (!result) return invalidResponse();
    // Returned ebook scope may be 17; never filter it against requested scope=10.
    for (const value of array(result.books)) {
      const item = record(value);
      const info = record(item?.bookInfo);
      if (!info) continue; // non-book search groups have no documented bookInfo.
      books.push(parseBook({ id: id(info.bookId), title: text(info.title), author: text(info.author) ?? "", kind: "ebook", status: "wanted",
        cover: cover(info.cover), deepLink: deepLink(info.deepLink) }));
      nextMaxIdx = count(item?.searchIdx) ?? nextMaxIdx;
    }
  }
  const hasMore = payload.hasMore === 1;
  if (hasMore && nextMaxIdx === undefined) return invalidResponse();
  return { books, hasMore, nextMaxIdx: hasMore ? nextMaxIdx : undefined };
}
