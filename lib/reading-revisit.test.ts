import { describe, expect, it } from "vitest";
import { emptyReadingLibrary, type ReadingLibrary } from "./reading";
import { filterReadingRevisit, nextReadingRevisit, readingRevisitItems } from "./reading-revisit";

function library(): ReadingLibrary {
  return { ...emptyReadingLibrary(), books: [
    { id: "book-a", title: "第一本", author: "作者", kind: "ebook" as const, status: "reading" as const },
    { id: "book-b", title: "第二本", author: "", kind: "ebook" as const, status: "finished" as const },
  ], highlights: [
    { id: "quote", bookId: "book-b", text: "划线原文", thought: "  " },
    { id: "thought", bookId: "book-a", text: "", thought: "只有自己的想法" },
    { id: "both", bookId: "book-a", text: "原摘录", thought: "当时的想法", chapter: "第五章" },
  ] };
}

describe("阅读偶然重逢", () => {
  it("按真实 bookId 保留来源，原文和想法不改写", () => {
    const source = library();
    const before = JSON.stringify(source);
    const items = readingRevisitItems(source);
    expect(items.map(item => item.book.title)).toEqual(["第二本", "第一本", "第一本"]);
    expect(items[2].note).toBe(source.highlights[2]);
    expect(JSON.stringify(source)).toBe(before);
  });
  it("不展示空文字或失去书籍来源的记录", () => {
    const source = library();
    source.highlights.push({ id: "blank", bookId: "book-a", text: " \n", thought: " " },
      { id: "orphan", bookId: "missing", text: "不能错配到其他书" });
    expect(readingRevisitItems(source).map(item => item.note.id)).toEqual(["quote", "thought", "both"]);
    expect(readingRevisitItems(emptyReadingLibrary())).toEqual([]);
  });
  it("划线和本人想法分别筛选，兼有两者的笔记保留上下文", () => {
    const items = readingRevisitItems(library());
    expect(filterReadingRevisit(items, "all")).toHaveLength(3);
    expect(filterReadingRevisit(items, "highlights").map(item => item.note.id)).toEqual(["quote", "both"]);
    expect(filterReadingRevisit(items, "thoughts").map(item => item.note.id)).toEqual(["thought", "both"]);
  });
  it("每轮看过全部后再重复，跨轮也不紧邻重复", () => {
    const ids = ["a", "b", "c"];
    let selection = { currentId: null as string | null, seen: [] as string[] };
    const sequence: string[] = [];
    for (let index = 0; index < 12; index++) {
      selection = nextReadingRevisit(ids, selection, () => .99);
      sequence.push(selection.currentId!);
    }
    for (let index = 0; index < sequence.length; index += 3) expect(new Set(sequence.slice(index, index + 3)).size).toBe(3);
    sequence.slice(1).forEach((id, index) => expect(id).not.toBe(sequence[index]));
  });
  it("资料改变时清理已不存在的编号，仍能带回新增记录", () => {
    const selected = nextReadingRevisit(["new", "remaining"], { currentId: "deleted", seen: ["deleted", "remaining"] }, () => 0);
    expect(selected).toEqual({ currentId: "new", seen: ["remaining", "new"] });
  });
  it("只有一条时可以安全重选，空库不会制造内容", () => {
    expect(nextReadingRevisit(["only"], { currentId: "only", seen: ["only"] })).toEqual({ currentId: "only", seen: ["only"] });
    expect(nextReadingRevisit([], { currentId: "old", seen: ["old"] })).toEqual({ currentId: null, seen: [] });
  });
  it.each([0, 1, -1, Number.NaN])("边界随机值 %s 不会越界", sample => {
    expect(["a", "b"]).toContain(nextReadingRevisit(["a", "b"], { currentId: null, seen: [] }, () => sample).currentId);
  });
});
