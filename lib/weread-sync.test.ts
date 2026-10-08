import { describe, expect, it, vi } from "vitest";
import { fetchWeReadLibrary } from "./weread-sync";
import { UpgradeRequired, WeReadClient, WEREAD_GATEWAY } from "./weread";

const now = new Date("2026-12-31T16:10:00Z"); // Already January 1, 2027, in Shanghai.
const response = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
const notebook = (id: string, sort = 10, extra: Record<string, unknown> = {}) => ({ bookId: id, sort, book: { title: `书籍 ${id}`, author: "作者" }, noteCount: 1, reviewCount: 1, bookmarkCount: 0, ...extra });
const highlight = (id: string, bookId: string) => ({ bookmarkId: id, bookId, markText: "保留下来的原文", chapterUid: 7, type: 1, createTime: 1798732800 });
const thought = (id: string, abstract = "保留下来的原文") => ({ review: { reviewId: id, abstract, content: "自己的想法", chapterName: "第七章", createTime: 1798732800 } });

/** Every request is intercepted; no real key and no network access are used. */
function mocked(handler: (body: Record<string, unknown>) => unknown | Promise<unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    expect(url).toBe(WEREAD_GATEWAY);
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body));
    expect(body.skill_version).toBe("1.0.4");
    expect(body).not.toHaveProperty("params");
    bodies.push(body);
    return response(await handler(body));
  });
  const client = new WeReadClient({ token: "offline-placeholder", fetch });
  return { client, bodies, fetch };
}

function basic(body: Record<string, unknown>): unknown {
  if (body.api_name === "/shelf/sync") return { books: [{ bookId: "a", title: "书架里的书", author: "书架作者", finishReading: 1 }], albums: [], mp: {} };
  if (body.api_name === "/readdata/detail") return body.mode === "overall"
    ? { totalReadTime: 7201, readDays: 3, baseTime: 0 }
    : { totalReadTime: 120, baseTime: 1798732800, dailyReadTimes: { 1798732800: 120 } };
  if (body.api_name === "/user/notebooks") return { books: [], hasMore: 0 };
  throw new Error("Unexpected offline mock request");
}

describe("temporary WeRead synchronization (offline gateway mocks)", () => {
  it("continues an empty-text review page and checks totals against all review IDs", async () => {
    const { client } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: 2 })], hasMore: 0 };
      if (body.api_name === "/review/list/mine") return body.synckey === 0
        ? { reviews: [{ review: { reviewId: "empty", content: "", star: -1 } }], totalCount: 2, hasMore: 1, synckey: 50 }
        : { reviews: [thought("text")], totalCount: 2, hasMore: 0 };
      return basic(body);
    });
    const result = await fetchWeReadLibrary(client, { now });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].id).toBe("review:text");
  });

  it("rejects repeated empty review IDs across pages", async () => {
    const { client } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: 2 })], hasMore: 0 };
      if (body.api_name === "/review/list/mine") return { reviews: [{ review: { reviewId: "repeated" } }], totalCount: 2,
        hasMore: body.synckey === 0 ? 1 : 0, synckey: 50 };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "PaginationError", reason: "duplicate_note_ids" });
  });

  it("bounds review records even when none contain exportable text or a declared total", async () => {
    const { client } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: undefined })], hasMore: 0 };
      if (body.api_name === "/review/list/mine") return { reviews: Array.from({ length: 10_001 }, (_, index) => ({ review: { reviewId: `empty-${index}` } })), hasMore: 0 };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "LimitExceeded", limitKind: "notes" });
  });

  it("preserves books, albums, article entrance, totals, hours, daily data, original text and thoughts across pages", async () => {
    const preferredHours = Array.from({ length: 24 }, (_, index) => index * 60);
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/shelf/sync") return { books: [{ bookId: "a", title: "书架里的书", author: "书架作者", finishReading: 1 }], albums: [{ albumInfo: { albumId: "audio", name: "听过的书", authorName: "演播者", finish: 1 }, albumInfoExtra: { lectureReadUpdateTime: 1798732800 } }], mp: { available: true }, bookCount: 999 };
      if (body.api_name === "/readdata/detail") return body.mode === "overall" ? {
        totalReadTime: 7201, readDays: 3, baseTime: 0, preferTime: preferredHours,
        readTimes: { 1767225600: 999999 }, readLongest: [{ book: { bookId: "a", title: "书架里的书", author: "书架作者", deepLink: "weread://reader?bookId=a", cover: "https://weread.qq.com/cover.jpg" }, readTime: 3600 }, { book: { bookId: "c", title: "读过但已移出书架", author: "作者" }, readTime: 600 }],
      } : { totalReadTime: 120, baseTime: 1798732800, dailyReadTimes: { 1798732800: 120 }, readTimes: { 1798732800: 999999 } };
      if (body.api_name === "/user/notebooks") return body.lastSort === undefined
        ? { totalBookCount: 2, totalNoteCount: 999, books: [notebook("a", 20, { reviewCount: 2, bookmarkCount: 994 })], hasMore: 1 }
        : { books: [notebook("b", 10)], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: [highlight(`h-${body.bookId}`, String(body.bookId)), { bookmarkId: "not-exported", type: 0 }], chapters: [{ chapterUid: 7, title: "第七章" }] };
      if (body.api_name === "/review/list/mine") return body.bookid === "a" && body.synckey === 0
        ? { reviews: [thought("a1")], hasMore: 1, synckey: 55, totalCount: 2 }
        : { reviews: [thought(body.bookid === "a" ? "a2" : "b1", "")], hasMore: 0 };
      throw new Error("Unexpected offline mock request");
    });
    const onProgress = vi.fn();
    const library = await fetchWeReadLibrary(client, { now, onProgress });
    expect(library.source).toBe("weread");
    expect(library.syncedAt).toBe(now.toISOString());
    expect(library.books).toHaveLength(5);
    expect(library.books.find(book => book.id === "a")).toMatchObject({ status: "finished", finished: true, secondsRead: 3600, deepLink: "weread://reader?bookId=a", cover: "https://weread.qq.com/cover.jpg" });
    expect(library.books.find(book => book.id === "c")?.status).toBe("reading");
    expect(library.books.find(book => book.id === "album:audio")).toMatchObject({ kind: "audiobook", status: "reading" });
    expect(library.books.find(book => book.id === "album:audio")?.finished).toBeUndefined();
    expect(library.books.find(book => book.id === "weread:articles")?.kind).toBe("article");
    expect(library.books.find(book => book.id === "b")?.title).toBe("书籍 b");
    expect(library.stats).toMatchObject({ mode: "overall", totalSeconds: 7201, readingDays: 3, period: { start: null, baseTime: 0 }, dailySeconds: [{ date: "2027-01-01", seconds: 120 }] });
    expect(library.stats?.preferredHours?.[0]).toEqual({ hour: 6, seconds: 0 });
    expect(library.highlights).toHaveLength(5);
    expect(library.highlights.find(item => item.id === "h-a")).toMatchObject({ bookId: "a", text: "保留下来的原文", chapter: "第七章", createdAt: "2027-01-01" });
    expect(library.highlights.find(item => item.id === "review:a2")).toMatchObject({ text: "", thought: "自己的想法" });
    expect(bodies.filter(body => body.api_name === "/readdata/detail")).toEqual([
      { api_name: "/readdata/detail", skill_version: "1.0.4", mode: "overall", baseTime: 0 },
      { api_name: "/readdata/detail", skill_version: "1.0.4", mode: "annually", baseTime: Date.UTC(2027, 0, 15, 12) / 1_000 },
    ]);
    const requestedYearTimestamp = Number(bodies.find(body => body.mode === "annually")?.baseTime) * 1_000;
    for (const timeZone of ["UTC", "Asia/Shanghai"]) expect(new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(new Date(requestedYearTimestamp))).toBe("2027");
    expect(bodies.filter(body => body.api_name === "/user/notebooks").map(body => body.lastSort)).toEqual([undefined, 20]);
    expect(bodies.filter(body => body.api_name === "/review/list/mine").map(body => body.synckey)).toEqual([0, 55, 0]);
    expect(bodies.filter(body => body.api_name === "/review/list/mine").every(body => body.count === 100)).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith({ stage: "complete", message: "已取回阅读数据，请先查看预览。" });
    expect(JSON.stringify(library)).not.toContain("offline-placeholder");
  });

  it("allows shelf and statistics alone without making any note requests", async () => {
    const { client, bodies } = mocked(basic);
    const result = await fetchWeReadLibrary(client, { now, includeNotes: false });
    expect(result.books).toHaveLength(1);
    expect(result.highlights).toEqual([]);
    expect(result.stats?.totalSeconds).toBe(7201);
    expect(bodies.map(body => body.api_name)).toEqual(["/shelf/sync", "/readdata/detail", "/readdata/detail"]);
  });

  it("halts immediately on an upgrade response, including a partially read notes page", async () => {
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a")], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: [highlight("h", "a")] };
      if (body.api_name === "/review/list/mine") return { upgrade_info: { message: "private gateway content offline-placeholder" } };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toBeInstanceOf(UpgradeRequired);
    expect(bodies.at(-1)?.api_name).toBe("/review/list/mine");
    expect(bodies).toHaveLength(6);
    await expect(client.shelf()).rejects.toBeInstanceOf(UpgradeRequired);
    expect(bodies).toHaveLength(6);
  });

  it("stops before the next request when an overall-stat response requires an upgrade", async () => {
    const { client, bodies } = mocked(body => body.api_name === "/readdata/detail" ? { upgrade_info: null } : basic(body));
    await expect(fetchWeReadLibrary(client, { now })).rejects.toBeInstanceOf(UpgradeRequired);
    expect(bodies.map(body => body.api_name)).toEqual(["/shelf/sync", "/readdata/detail"]);
  });

  it("detects a repeated notebook cursor and never returns partial data", async () => {
    const { client, bodies } = mocked(body => body.api_name === "/user/notebooks"
      ? { books: [notebook(body.lastSort === undefined ? "a" : "b", 10)], hasMore: 1 } : basic(body));
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "PaginationError", reason: "notebook_cursor_repeated" });
    expect(bodies.filter(body => body.api_name === "/user/notebooks")).toHaveLength(2);
    expect(bodies.some(body => body.api_name === "/book/bookmarklist")).toBe(false);
  });

  it("detects a repeated thought cursor", async () => {
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0 })], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: [] };
      if (body.api_name === "/review/list/mine") return { reviews: [thought(body.synckey === 0 ? "t1" : "t2")], hasMore: 1, synckey: 55 };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "PaginationError", reason: "thought_cursor_repeated" });
    expect(bodies.filter(body => body.api_name === "/review/list/mine")).toHaveLength(2);
  });

  it("rejects an empty continuing page and duplicated records across pages", async () => {
    for (const secondPage of [{ books: [], hasMore: 1 }, { books: [notebook("a", 5)], hasMore: 0 }]) {
      const { client } = mocked(body => body.api_name === "/user/notebooks"
        ? body.lastSort === undefined ? { books: [notebook("a", 10)], hasMore: 1 } : secondPage : basic(body));
      await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: secondPage.books.length ? "PaginationError" : "InvalidResponse" });
    }
  });

  it("rejects an ending notebook or thought page that is short of its declared total", async () => {
    const notebookShortfall = mocked(body => body.api_name === "/user/notebooks"
      ? { totalBookCount: 2, books: [notebook("a")], hasMore: 0 } : basic(body));
    await expect(fetchWeReadLibrary(notebookShortfall.client, { now })).rejects.toMatchObject({ code: "InvalidData", reason: "notebook_total_shortfall" });
    const thoughtsShortfall = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a")], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: [highlight("h", "a")] };
      if (body.api_name === "/review/list/mine") return { reviews: [thought("t")], totalCount: 2, hasMore: 0 };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(thoughtsShortfall.client, { now })).rejects.toMatchObject({ code: "InvalidData", reason: "thought_total_shortfall" });
  });

  it("rejects note contents that are short of known notebook counts", async () => {
    for (const shortfall of ["highlights", "thoughts"]) {
      const { client } = mocked(body => {
        if (body.api_name === "/user/notebooks") return { books: [notebook("a")], hasMore: 0 };
        if (body.api_name === "/book/bookmarklist") return { updated: shortfall === "highlights" ? [] : [highlight("h", "a")] };
        if (body.api_name === "/review/list/mine") return { reviews: [], hasMore: 0 };
        return basic(body);
      });
      await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "InvalidData",
        reason: shortfall === "highlights" ? "highlight_count_mismatch" : "thought_notebook_count_mismatch" });
    }
  });

  it("reads complete notebook and thought sequences when pagination uses boolean flags", async () => {
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") return body.lastSort === undefined
        ? { totalBookCount: 2, books: [notebook("a", 20, { reviewCount: 2 })], hasMore: true }
        : { totalBookCount: 2, books: [notebook("b", 10, { reviewCount: 0 })], hasMore: false };
      if (body.api_name === "/book/bookmarklist") return { updated: [highlight(`h-${body.bookId}`, String(body.bookId))] };
      if (body.api_name === "/review/list/mine") return body.synckey === 0
        ? { totalCount: 2, reviews: [thought("first")], hasMore: true, synckey: 55 }
        : { totalCount: 2, reviews: [thought("second")], hasMore: false };
      return basic(body);
    });
    const result = await fetchWeReadLibrary(client, { now });
    expect(result.books).toHaveLength(2);
    expect(result.highlights).toHaveLength(4);
    expect(bodies.filter(body => body.api_name === "/user/notebooks").map(body => body.lastSort)).toEqual([undefined, 20]);
    expect(bodies.filter(body => body.api_name === "/review/list/mine").map(body => body.synckey)).toEqual([0, 55]);
  });

  it("identifies a changed notebook total without exposing any book metadata", async () => {
    const { client } = mocked(body => body.api_name === "/user/notebooks"
      ? body.lastSort === undefined
        ? { totalBookCount: 2, books: [notebook("a", 20)], hasMore: 1 }
        : { totalBookCount: 3, books: [notebook("b", 10)], hasMore: 0 }
      : basic(body));
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "InvalidData", reason: "notebook_total_changed" });
  });

  it("requests thoughts with count 100 and explicit initial synckey zero, then collects every page", async () => {
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: 150 })], hasMore: 0, totalBookCount: 1 };
      if (body.api_name === "/review/list/mine") return body.synckey === 0
        ? { totalCount: 150, reviews: Array.from({ length: 100 }, (_, index) => thought(`t-${index}`)), hasMore: 1, synckey: 100 }
        : { totalCount: 150, reviews: Array.from({ length: 50 }, (_, index) => thought(`t-${index + 100}`)), hasMore: 0 };
      return basic(body);
    });
    const result = await fetchWeReadLibrary(client, { now });
    expect(result.highlights).toHaveLength(150);
    expect(bodies.filter(body => body.api_name === "/review/list/mine")).toEqual([
      { bookid: "a", count: 100, synckey: 0, api_name: "/review/list/mine", skill_version: "1.0.4" },
      { bookid: "a", count: 100, synckey: 100, api_name: "/review/list/mine", skill_version: "1.0.4" },
    ]);
    expect(bodies.find(body => body.api_name === "/user/notebooks")?.count).toBe(20);
  });

  it("still requests thoughts with unknown notebook and response totals", async () => {
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: undefined })], hasMore: 0 };
      if (body.api_name === "/review/list/mine") return { reviews: [thought("unknown-total")], hasMore: 0 };
      return basic(body);
    });
    expect((await fetchWeReadLibrary(client, { now })).highlights).toHaveLength(1);
    expect(bodies.find(body => body.api_name === "/review/list/mine")).toMatchObject({ bookid: "a", count: 100, synckey: 0 });
  });

  it.each([
    [0, 1, "thought_total_zero_with_content"],
    [1, 2, "thought_total_excess"],
    [3, 2, "thought_total_shortfall"],
  ] as const)("identifies inconsistent declared thought totals with the fixed %s/%s relationship", async (declared, observed, reason) => {
    const { client } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: undefined })], hasMore: 0 };
      if (body.api_name === "/review/list/mine") return { totalCount: declared, reviews: Array.from({ length: observed }, (_, index) => thought(`t-${index}`)), hasMore: 0 };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "InvalidData", reason });
  });

  it("fully reads more than 80 notebook books across all pages", async () => {
    const entries = Array.from({ length: 81 }, (_, index) => notebook(index === 0 ? "a" : `book-${index}`, 1_000 - index, { reviewCount: 0 }));
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") {
        const start = body.lastSort === undefined ? 0 : 1_001 - Number(body.lastSort);
        return { totalBookCount: 81, books: entries.slice(start, start + 20), hasMore: start + 20 < entries.length ? 1 : 0 };
      }
      if (body.api_name === "/book/bookmarklist") return { updated: [highlight(`h-${body.bookId}`, String(body.bookId))] };
      return basic(body);
    });
    const result = await fetchWeReadLibrary(client, { now });
    expect(result.books).toHaveLength(81);
    expect(result.highlights).toHaveLength(81);
    expect(bodies.filter(body => body.api_name === "/user/notebooks")).toHaveLength(5);
    expect(bodies.filter(body => body.api_name === "/book/bookmarklist")).toHaveLength(81);
    expect(bodies.some(body => body.api_name === "/review/list/mine")).toBe(false);
  });

  it("reports the 1000-book limit before reading any note contents", async () => {
    const { client, bodies } = mocked(body => body.api_name === "/user/notebooks"
      ? { totalBookCount: 1_001, books: [notebook("a")], hasMore: 0 } : basic(body));
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "LimitExceeded", limitKind: "notebooks" });
    expect(bodies.some(body => body.api_name === "/book/bookmarklist")).toBe(false);
  });

  it("enforces the actual 1000-book limit when notebook total counts are unknown", async () => {
    const entries = Array.from({ length: 1_001 }, (_, index) => notebook(`book-${index}`, 1_500 - index, { noteCount: 0, reviewCount: 0 }));
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") {
        const start = body.lastSort === undefined ? 0 : 1_501 - Number(body.lastSort);
        return { books: entries.slice(start, start + 20), hasMore: start + 20 < entries.length ? 1 : 0 };
      }
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "LimitExceeded", limitKind: "notebooks" });
    expect(bodies.filter(body => body.api_name === "/user/notebooks")).toHaveLength(51);
    expect(bodies.some(body => body.api_name === "/book/bookmarklist" || body.api_name === "/review/list/mine")).toBe(false);
  });

  it("skips only content categories with a known zero count and still reads unknown counts", async () => {
    const { client, bodies } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [
        notebook("a", 40, { noteCount: 0, reviewCount: 0, bookmarkCount: 1 }),
        notebook("thought-only", 30, { noteCount: 0 }),
        notebook("highlight-only", 20, { reviewCount: 0 }),
        notebook("unknown-counts", 10, { noteCount: undefined, reviewCount: undefined }),
      ], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: [highlight(`h-${body.bookId}`, String(body.bookId))] };
      if (body.api_name === "/review/list/mine") return { reviews: [thought(`t-${body.bookid}`)], hasMore: 0, totalCount: 1 };
      return basic(body);
    });
    const result = await fetchWeReadLibrary(client, { now });
    expect(result.highlights).toHaveLength(4);
    expect(bodies.filter(body => body.api_name === "/book/bookmarklist").map(body => body.bookId)).toEqual(["highlight-only", "unknown-counts"]);
    expect(bodies.filter(body => body.api_name === "/review/list/mine").map(body => body.bookid)).toEqual(["thought-only", "unknown-counts"]);
  });

  it("limits exportable notes without mistaking bookmark counts for exportable content", async () => {
    const { client, bodies } = mocked(body => body.api_name === "/user/notebooks"
      ? { books: [notebook("a", 10, { noteCount: 10_001, reviewCount: 0, bookmarkCount: 0 })], hasMore: 0 } : basic(body));
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "LimitExceeded", limitKind: "notes" });
    expect(bodies.some(body => body.api_name === "/book/bookmarklist")).toBe(false);
    const bookmarksOnly = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 0, reviewCount: 0, bookmarkCount: 20_000 })], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: [] };
      if (body.api_name === "/review/list/mine") return { reviews: [], hasMore: 0 };
      return basic(body);
    });
    expect((await fetchWeReadLibrary(bookmarksOnly.client, { now })).highlights).toEqual([]);
  });

  it("enforces the actual content limit even when notebook estimates undercount", async () => {
    const { client } = mocked(body => {
      if (body.api_name === "/user/notebooks") return { books: [notebook("a", 10, { noteCount: 1, reviewCount: 0 })], hasMore: 0 };
      if (body.api_name === "/book/bookmarklist") return { updated: Array.from({ length: 10_001 }, (_, index) => highlight(`h-${index}`, "a")) };
      return basic(body);
    });
    await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "LimitExceeded", limitKind: "notes" });
  });

  it("discards partial data after a request failure or notes belonging to another book", async () => {
    for (const mode of ["failure", "wrong-book"]) {
      const { client } = mocked(body => {
        if (body.api_name === "/user/notebooks") return { books: [notebook("a")], hasMore: 0 };
        if (body.api_name === "/book/bookmarklist") return { updated: [highlight("h", mode === "wrong-book" ? "unexpected" : "a")] };
        if (body.api_name === "/review/list/mine") throw new Error("private mock request details offline-placeholder");
        return basic(body);
      });
      await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: mode === "failure" ? "NetworkError" : "InvalidData" });
    }
  });

  it("does not substitute annual totals or monthly buckets for absent daily data", async () => {
    const { client } = mocked(body => body.api_name === "/readdata/detail" && body.mode === "annually"
      ? { totalReadTime: 999999, readTimes: { 1798732800: 999999 } } : basic(body));
    const library = await fetchWeReadLibrary(client, { now });
    expect(library.stats?.totalSeconds).toBe(7201);
    expect(library.stats?.dailySeconds).toEqual([]);
  });

  it("rejects a missing authoritative total and daily records outside the requested Shanghai year", async () => {
    for (const annual of [{ dailyReadTimes: { 1798732800: 120 } }, { totalReadTime: 120, dailyReadTimes: { 1767196800: 120 } }]) {
      const { client } = mocked(body => body.api_name === "/readdata/detail" && body.mode === "annually" ? annual : basic(body));
      await expect(fetchWeReadLibrary(client, { now })).rejects.toMatchObject({ code: "InvalidData" });
    }
  });
});
