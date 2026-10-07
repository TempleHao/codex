import { describe, expect, it } from "vitest";
import { emptyReadingLibrary, formatReadingSeconds, isSafeReadingLink, mergeReadingLibraries, parseReadingImport, readingLibrarySchema } from "./reading";
import type { ReadingBook, ReadingLibrary } from "./reading";

const book: ReadingBook = { id: "demo-book", title: "示例书籍", author: "示例作者", kind: "ebook", status: "reading" };
const library = (): ReadingLibrary => ({ ...emptyReadingLibrary(), books: [{ ...book }] });

describe("portable reading imports", () => {
  it("converts a versioned items import and preserves one-percent progress", () => {
    const data = parseReadingImport(JSON.stringify({ version: 1, source: "weread", items: [{ ...book, progress: 1 }] }));
    expect(data).toEqual({ version: 1, source: "weread", books: [{ ...book, progress: 1 }], highlights: [], stats: null, syncedAt: null });
  });

  it("accepts the full library export without dropping books, notes or stats", () => {
    const data = { ...library(), syncedAt: "2026-10-07T10:00:00+08:00",
      highlights: [{ id: "highlight-demo", bookId: book.id, text: "示例原文", thought: "示例想法", createdAt: "2024-02-29" }],
      stats: { totalSeconds: 3601, readingDays: 2, dailySeconds: [{ date: "2026-10-07", seconds: 120 }], mode: "monthly", period: null } };
    expect(parseReadingImport(JSON.stringify(data))).toEqual(data);
  });

  it("validates real calendar dates and ISO timestamps", () => {
    expect(() => parseReadingImport({ version: 1, source: "manual", items: [{ ...book, lastReadAt: "2024-02-29" }] })).not.toThrow();
    for (const lastReadAt of ["2023-02-29", "2026-04-31", "2026-13-01", "明天", "2026-10-07T12:00:00"]) {
      expect(() => parseReadingImport({ version: 1, source: "manual", items: [{ ...book, lastReadAt }] })).toThrow();
    }
  });

  it("requires the version, source, items and book identity fields", () => {
    for (const input of [{ items: [] }, { version: 1, source: "manual" }, { version: 2, source: "manual", items: [] }, { version: 1, source: "manual", items: [{ id: "missing-title" }] }]) {
      expect(() => parseReadingImport(input)).toThrow();
    }
    expect(() => parseReadingImport("not JSON private text")).toThrow("完整的 JSON");
    expect(() => parseReadingImport({ version: 1, source: "manual", items: [book], "private-user-field": "private-user-content" })).not.toThrow("private-user-field");
    expect(() => parseReadingImport({ version: 1, source: "manual", items: [book], "private-user-field": "private-user-content" })).not.toThrow("private-user-content");
  });

  it("rejects duplicate identities and notes without a related book", () => {
    expect(() => parseReadingImport({ version: 1, source: "manual", items: [book, book] })).toThrow("重复编号");
    expect(() => parseReadingImport({ version: 1, source: "manual", items: [book], highlights: [{ id: "h", bookId: "missing", text: "示例" }] })).toThrow("缺少关联书籍");
  });

  it("does not accept raw gateway payloads as portable imports", () => {
    expect(() => parseReadingImport({ errcode: 0, books: [{ bookId: "demo", title: "示例" }] })).toThrow();
    expect(() => parseReadingImport({ version: 1, source: "manual", items: [{ ...book, progress: 101 }] })).toThrow();
  });

  it("rejects duplicated day records rather than double-counting", () => {
    expect(readingLibrarySchema.safeParse({ ...library(), stats: { totalSeconds: 120, mode: "monthly", period: null, dailySeconds: [
      { date: "2026-10-07", seconds: 60 }, { date: "2026-10-07", seconds: 60 },
    ] } }).success).toBe(false);
  });
});

describe("safe reading links and merge", () => {
  it("only accepts absolute trusted schemes without embedded credentials", () => {
    expect(isSafeReadingLink("https://weread.qq.com/web/bookDetail/demo")).toBe(true);
    expect(isSafeReadingLink("weread://reader?bookId=demo")).toBe(true);
    for (const value of ["javascript:alert(1)", "data:text/html,demo", "http://weread.qq.com/demo", "file:///tmp/demo", "/relative", "//weread.qq.com/demo", "https://name:password@weread.qq.com/demo", "https://weread.qq.com/\nreader", "weread:reader"]) {
      expect(isSafeReadingLink(value)).toBe(false);
      expect(() => parseReadingImport({ version: 1, source: "manual", items: [{ ...book, deepLink: value }] })).toThrow();
    }
  });

  it("preserves manual entries and updates IDs present in a new import", () => {
    const existing = { ...library(), books: [book, { ...book, id: "manual-extra", title: "手动记录" }], highlights: [{ id: "old-note", bookId: book.id, text: "保留笔记" }] };
    const incoming = { ...library(), source: "weread" as const, books: [{ ...book, title: "更新书名", status: "finished" as const }], syncedAt: "2026-10-07T00:00:00Z" };
    const merged = mergeReadingLibraries(existing, incoming);
    expect(merged.books.map(item => item.title)).toEqual(["更新书名", "手动记录"]);
    expect(merged.highlights).toEqual(existing.highlights);
    expect(existing.books[0].title).toBe("示例书籍");
    expect(merged.syncedAt).toBe(incoming.syncedAt);
  });

  it("formats seconds into hours and minutes", () => {
    expect(formatReadingSeconds(3661)).toBe("1小时1分钟");
    expect(formatReadingSeconds(59)).toBe("0小时0分钟");
  });

  it("retains earlier daily history while updating an authoritative statistics snapshot", () => {
    const existing = { ...library(), stats: { totalSeconds: 5000, mode: "overall" as const, period: null, dailySeconds: [{ date: "2025-12-31", seconds: 600 }, { date: "2026-10-07", seconds: 10 }] } };
    const incoming = { ...library(), stats: { totalSeconds: 9000, mode: "overall" as const, period: null, dailySeconds: [{ date: "2026-10-07", seconds: 60 }] } };
    const merged = mergeReadingLibraries(existing, incoming);
    expect(merged.stats?.totalSeconds).toBe(9000);
    expect(merged.stats?.dailySeconds).toEqual([{ date: "2025-12-31", seconds: 600 }, { date: "2026-10-07", seconds: 60 }]);
    expect(existing.stats.dailySeconds[1].seconds).toBe(10);
  });
});
