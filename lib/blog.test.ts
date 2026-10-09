import { describe, expect, it } from "vitest";
import { blogArchiveSchema, isBlogSourceUrl, mergeBlogArchives, normalizeBlogArchive } from "./blog";
const entry = { id: "ashsilent:shuoshuo:1", sourceUrl: "https://www.ashsilent.com/shuoshuo/a-slug", date: "2026-01-01T00:00:00Z", text: "old", title: "", author: "Temple", images: [], media: [], links: [] };
const archive = { version: 1 as const, sourceUrl: "https://www.ashsilent.com/" as const, updatedAt: "2026-01-02T00:00:00Z", entries: [entry] };
describe("public blog archive", () => {
  it("accepts slug sources but rejects other domains, articles, and duplicate IDs", () => {
    expect(blogArchiveSchema.safeParse(archive).success).toBe(true);
    expect(isBlogSourceUrl("https://www.ashsilent.com.evil.test/shuoshuo/1", true)).toBe(false);
    expect(blogArchiveSchema.safeParse({ ...archive, entries: [{ ...entry, sourceUrl: "https://www.ashsilent.com/article/1" }] }).success).toBe(false);
    expect(blogArchiveSchema.safeParse({ ...archive, entries: [entry, entry] }).success).toBe(false);
    expect(blogArchiveSchema.safeParse({ ...archive, entries: [{ ...entry, text: 123 }] }).success).toBe(false);
  });
  it("retains old history and applies incoming revisions", () => {
    const before = normalizeBlogArchive({ ...archive, entries: [entry, { ...entry, id: "ashsilent:shuoshuo:2" }] });
    const next = mergeBlogArchives(before, { ...archive, entries: [{ ...entry, text: "revised" }] });
    expect(next.entries).toHaveLength(2);
    expect(next.entries.find(item => item.id === entry.id)?.text).toBe("revised");
  });
});
