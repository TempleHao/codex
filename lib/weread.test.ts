import { describe, expect, it, vi } from "vitest";
import { normalizeBookProgress, normalizeHighlights, normalizeNotebooks, normalizeSearch, normalizeShelf, normalizeStats, normalizeThoughts, UpgradeRequired, unwrapWeReadResponse, WeReadClient, WEREAD_GATEWAY } from "./weread";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mockClient = (value: unknown = { errcode: 0 }) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(value));
  return { client: new WeReadClient({ token: "demo-runtime-only", fetch }), fetch };
};

describe("official read-only gateway client (all requests mocked)", () => {
  it("calls fetch with the global receiver required by browser-native fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response({ books: [] }));
    });
    const client = new WeReadClient({ token: "demo-runtime-only", fetch });
    await expect(client.shelf()).resolves.toEqual({ books: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.contexts[0]).toBe(globalThis);
  });

  it("uses the documented endpoint, bearer header and flat parameters on every method", async () => {
    const { client, fetch } = mockClient();
    await client.shelf();
    await client.stats("annually", 1767225600);
    await client.notebooks(100, 1778312777);
    await client.bookProgress("demo-book");
    await client.highlights("demo-book");
    await client.thoughts("demo-book", { count: 20, synckey: 55 });
    await client.search("示例书籍");
    const bodies = fetch.mock.calls.map(([url, init]) => {
      expect(url).toBe(WEREAD_GATEWAY);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ Authorization: "Bearer demo-runtime-only", "Content-Type": "application/json" });
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.skill_version).toBe("1.0.4");
      expect(body).not.toHaveProperty("params");
      return body;
    });
    expect(bodies.map(body => body.api_name)).toEqual(["/shelf/sync", "/readdata/detail", "/user/notebooks", "/book/getprogress", "/book/bookmarklist", "/review/list/mine", "/store/search"]);
    expect(bodies[1]).toMatchObject({ mode: "annually", baseTime: 1767225600 });
    expect(bodies[2]).toMatchObject({ count: 100, lastSort: 1778312777 });
    expect(bodies[5]).toMatchObject({ bookid: "demo-book", count: 20, synckey: 55 });
    expect(bodies[5]).not.toHaveProperty("bookId");
    expect(bodies[6]).toMatchObject({ keyword: "示例书籍", scope: 10 });
    expect(bodies[6]).not.toHaveProperty("count");
  });

  it("uses baseTime=0 for overall and whitelists runtime option fields", async () => {
    const { client, fetch } = mockClient();
    await client.stats("overall", 123);
    await client.search("示例", { scope: undefined, count: 3, maxIdx: 9, api_name: "/unwanted" } as never);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ mode: "overall", baseTime: 0 });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ keyword: "示例", scope: 10, count: 3, maxIdx: 9, api_name: "/store/search", skill_version: "1.0.4" });
  });

  it("halts the client after any upgrade_info and never reflects its raw message", async () => {
    const { client, fetch } = mockClient({ errcode: 0, upgrade_info: { message: "private-server-content demo-runtime-only" } });
    await expect(client.shelf()).rejects.toBeInstanceOf(UpgradeRequired);
    await expect(client.stats()).rejects.toBeInstanceOf(UpgradeRequired);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.highlights("demo-book")).rejects.not.toThrow("private-server-content");
  });

  it("also honors upgrade_info inside a compatibility envelope and HTTP failures", async () => {
    const { client } = mockClient({ data: { upgrade_info: null } });
    await expect(client.shelf()).rejects.toBeInstanceOf(UpgradeRequired);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ upgrade_info: { message: "example" } }, 403));
    await expect(new WeReadClient({ token: "demo", fetch }).shelf()).rejects.toBeInstanceOf(UpgradeRequired);
  });

  it("aborts concurrent in-flight work when one response requires upgrading", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }))
      .mockImplementationOnce(async () => response({ upgrade_info: { message: "demo upgrade" } }));
    const client = new WeReadClient({ token: "demo", fetch });
    const pending = client.shelf().catch(error => error);
    await expect(client.stats()).rejects.toBeInstanceOf(UpgradeRequired);
    expect(await pending).toBeInstanceOf(UpgradeRequired);
    await expect(client.notebooks()).rejects.toBeInstanceOf(UpgradeRequired);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("redacts business errors, network errors and invalid JSON", async () => {
    const { client } = mockClient({ errcode: -99, errmsg: "private-server-message demo-runtime-only" });
    await expect(client.shelf()).rejects.toMatchObject({ code: "BusinessError" });
    await expect(client.shelf()).rejects.not.toThrow("private-server-message");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("demo-runtime-only private-network-message"));
    await expect(new WeReadClient({ token: "demo", fetch }).shelf()).rejects.not.toThrow("private-network-message");
    const invalidFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("private-invalid-json"));
    await expect(new WeReadClient({ token: "demo", fetch: invalidFetch }).shelf()).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  it("aborts timed-out requests", async () => {
    let aborted = false;
    const fetch: typeof globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private abort detail")); });
    });
    await expect(new WeReadClient({ token: "demo", fetch, timeoutMs: 5 }).shelf()).rejects.toMatchObject({ code: "Timeout" });
    expect(aborted).toBe(true);
  });

  it("clears runtime credentials on disconnect and makes no later request", async () => {
    const { client, fetch } = mockClient();
    client.disconnect();
    await expect(client.shelf()).rejects.toMatchObject({ code: "InvalidInput" });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(client)).toBe("{}");
  });
});

describe("documented WeRead normalizers", () => {
  it("counts electronic books, independent albums and one nonempty article entrance", () => {
    const books = normalizeShelf({ errcode: 0, data: { bookCount: 999, books: [{ bookId: "e", title: "示例电子书", author: "作者", finishReading: 1,
      readUpdateTime: 1791389400, deepLink: "weread://reader?bookId=e" }], albums: [{ albumInfo: { albumId: "a", name: "示例听书", authorName: "演播者", finish: 1,
      finishStatus: "已完结", updateTime: 1791389400 }, albumInfoExtra: { lectureReadUpdateTime: 1791389400 } }], mp: { example: true } } });
    expect(books).toHaveLength(3);
    expect(books.map(book => book.kind)).toEqual(["ebook", "audiobook", "article"]);
    expect(books[0]).toMatchObject({ status: "finished", finished: true, deepLink: "weread://reader?bookId=e" });
    expect(books[1]).toMatchObject({ status: "reading", lastReadAt: "2026-10-08" });
    expect(books[1].finished).toBeUndefined();
    expect(books[1].deepLink).toBeUndefined();
    expect(normalizeShelf({ books: [], albums: [], mp: {} })).toEqual([]);
  });

  it("treats getprogress=1 as one percent and requires a finish timestamp to claim completion", () => {
    expect(normalizeBookProgress({ book: { progress: 1, recordReadingTime: 75, updateTime: 1791389400 } })).toMatchObject({ progress: 1, secondsRead: 75, status: "reading", finished: false });
    expect(normalizeBookProgress({ book: { progress: 100 } }).finished).toBe(false);
    expect(normalizeBookProgress({ book: { progress: 100, finishTime: 1791389400 } }).finished).toBe(true);
  });

  it("keeps totalReadTime authoritative and displays Unix dates in Shanghai", () => {
    const stats = normalizeStats({ totalReadTime: 7200, readDays: 3, baseTime: 1790784000,
      readTimes: { "1791302400": 60, "1791388800": 120 }, preferTime: Array.from({ length: 24 }, (_unused, index) => index) }, "monthly")!;
    expect(stats.totalSeconds).toBe(7200);
    expect(stats.readingDays).toBe(3);
    expect(stats.dailySeconds).toEqual([{ date: "2026-10-07", seconds: 60 }, { date: "2026-10-08", seconds: 120 }]);
    expect(stats.preferredHours?.[0]).toEqual({ hour: 6, seconds: 0 });
    expect(stats.preferredHours?.[18]).toEqual({ hour: 0, seconds: 18 });
    expect(stats.period).toEqual({ baseTime: 1790784000, start: "2026-10-01" });
  });

  it("does not mislabel yearly/monthly buckets as daily or invent missing totals/counts", () => {
    expect(normalizeStats({ totalReadTime: 90, readTimes: { "1790784000": 90 } }, "annually")?.dailySeconds).toEqual([]);
    expect(normalizeStats({ totalReadTime: 90, baseTime: 0, readTimes: { "1767225600": 90 } }, "overall")?.period).toEqual({ start: null, baseTime: 0 });
    expect(normalizeStats({ readTimes: { "1790784000": 90 }, readDays: 1 })).toBeNull();
    expect(normalizeStats({ totalReadTime: 90 })?.readingDays).toBeUndefined();
    expect(normalizeStats({ totalReadTime: 90, readTimes: { "1790784000": 900 }, dailyReadTimes: { "1791302400": 90 } }, "annually")?.dailySeconds).toEqual([{ date: "2026-10-07", seconds: 90 }]);
  });

  it("uses notebook counts and last-sort cursor without guessing its progress unit", () => {
    const data = normalizeNotebooks({ books: [{ bookId: "demo", book: { title: "示例书籍", author: "作者" }, noteCount: 2, reviewCount: 3, bookmarkCount: 4, readingProgress: 0.5, markedStatus: 0, sort: 1778312777 }], hasMore: 1 });
    expect(data.books[0]).toMatchObject({ highlightCount: 2, thoughtCount: 3, bookmarkCount: 4, totalNoteCount: 9 });
    expect(data.books[0].book.progress).toBeUndefined();
    expect(data.nextLastSort).toBe(1778312777);
    expect(() => normalizeNotebooks({ books: [], hasMore: 1 })).toThrow();
  });

  it("maps highlight text and chapter names while excluding bookmark contents", () => {
    const notes = normalizeHighlights({ updated: [{ bookmarkId: "skip", type: 0 }, { bookmarkId: "h", bookId: "demo", type: 1, chapterUid: 7, markText: "示例划线", createTime: 1791389400 }], chapters: [{ chapterUid: 7, title: "示例章节" }] }, "demo");
    expect(notes).toEqual([{ id: "h", bookId: "demo", text: "示例划线", chapter: "示例章节", createdAt: "2026-10-08" }]);
  });

  it("preserves thoughts without an abstract and keeps their pagination cursor", () => {
    const notes = normalizeThoughts({ reviews: [{ review: { reviewId: "r1", content: "整本书的示例想法" } }, { review: { reviewId: "r2", content: "划线想法", abstract: "示例原文", chapterName: "示例章节" } }], hasMore: 1, synckey: 123, totalCount: 5 }, "demo");
    expect(notes.highlights[0]).toMatchObject({ id: "review:r1", text: "", thought: "整本书的示例想法" });
    expect(notes.highlights[1]).toMatchObject({ text: "示例原文", thought: "划线想法", chapter: "示例章节" });
    expect(notes.nextSynckey).toBe(123);
  });

  it("accepts electronic search groups returned with scope 17", () => {
    expect(normalizeSearch({ results: [{ scope: 17, books: [{ searchIdx: 9, bookInfo: { bookId: "demo", title: "示例书籍", author: "作者" } }] }], hasMore: 1 })).toMatchObject({ books: [{ id: "demo" }], nextMaxIdx: 9, hasMore: true });
    expect(() => normalizeSearch({ results: [{ books: [{ bookInfo: { bookId: "demo", title: "示例书籍" } }] }], hasMore: 1 })).toThrow();
  });

  it("supports only explicit response envelope shapes and drops unsafe returned links", () => {
    expect(unwrapWeReadResponse({ errcode: 0, data: { books: [] } })).toEqual({ books: [] });
    expect(() => normalizeShelf({ result: { books: [] } })).toThrow();
    expect(() => unwrapWeReadResponse({ data: { errcode: -1, errmsg: "private" } })).toThrow();
    expect(normalizeShelf({ books: [{ bookId: "demo", title: "示例", deepLink: "javascript:alert(1)" }] })[0].deepLink).toBeUndefined();
  });
});
