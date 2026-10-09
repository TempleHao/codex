import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBlogFeed, runBlogSyncJob } from "./blog-sync-job";
const folders: string[] = [];
async function folder() { const value = await mkdtemp(path.join(os.tmpdir(), "blog-test-")); folders.push(value); return value; }
afterEach(async () => { await Promise.all(folders.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
const xml = (body: string, link = "https://www.ashsilent.com/shuoshuo/slug") => `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><link>${link}</link><guid>https://www.ashsilent.com/?post_type=shuoshuo&amp;p=123</guid><pubDate>Wed, 07 Oct 2026 23:35:24 +0000</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`;
const entry = { id: "ashsilent:shuoshuo:1", sourceUrl: "https://www.ashsilent.com/shuoshuo/1", date: "2026-01-01T00:00:00Z", text: "history", title: "", author: "", images: [], links: [], media: [] };
const archive = { version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-01-01T00:00:00Z", entries: [entry] };
describe("RSS synchronization", () => {
  it("parses entities and CDATA, retains paragraphs and media, excludes ordinary articles", async () => {
    const parsed = await parseBlogFeed(xml('<p>A &amp; B</p><p>第二段<img src="/a.jpg" alt="图"></p><script>secret</script><audio src="/a.mp3"></audio>'));
    expect(parsed.entries[0]).toMatchObject({ id: "ashsilent:shuoshuo:123", text: "A & B\n第二段", images: [{ url: "https://www.ashsilent.com/a.jpg", alt: "图" }], media: [{ kind: "audio", url: "https://www.ashsilent.com/a.mp3" }] });
    expect((await parseBlogFeed(xml("article", "https://www.ashsilent.com/article"))).entries).toEqual([]);
    await expect(parseBlogFeed('<rss><channel>')).rejects.toThrow();
    await expect(parseBlogFeed('<!DOCTYPE rss [<!ENTITY x "bad">]><rss><channel/></rss>')).rejects.toThrow();
  });
  it("uses deterministic guid hashes for nonnumeric slugs", async () => {
    const text = xml("hello").replace('post_type=shuoshuo&amp;p=123', 'old-slug');
    const first = await parseBlogFeed(text);
    expect(first.entries[0].id).toMatch(/^ashsilent:shuoshuo:guid-[a-f0-9]{24}$/);
    expect((await parseBlogFeed(text)).entries[0].id).toBe(first.entries[0].id);
  });
  it("preserves complete previous archive after a later-page failure", async () => {
    const output = await folder();
    await writeFile(path.join(output, "blog-sync.json"), JSON.stringify(archive));
    const fetch = vi.fn().mockResolvedValueOnce(new Response(xml("new"))).mockRejectedValueOnce(new Error("upstream"));
    const status = await runBlogSyncJob({ LIFE_SYNC_OUTPUT_DIR: output }, { fetch });
    expect(status.state).toBe("preserved");
    expect(JSON.parse(await readFile(path.join(output, "blog-sync.json"), "utf8"))).toEqual(archive);
  });
  it("rejects malformed prior snapshots before any upstream request", async () => {
    const output = await folder();
    const fetch = vi.fn().mockResolvedValue(new Response('{"entries":123}'));
    await expect(runBlogSyncJob({ LIFE_SYNC_OUTPUT_DIR: output }, { fetch })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("walks full history through a terminal404 on first run", async () => {
    const output = await folder();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(new Response(xml('hello'))).mockResolvedValueOnce(new Response('', { status: 404 }));
    const status = await runBlogSyncJob({ LIFE_SYNC_OUTPUT_DIR: output }, { fetch });
    expect(status.state).toBe("ready");
    expect(JSON.parse(await readFile(path.join(output, 'blog-sync.json'), 'utf8')).entries).toHaveLength(1);
  });
  it("overlaps two pages incrementally and audits old pages in full mode", async () => {
    const make = (text: string) => ({ itemCount: 1, entries: [{ ...entry, id: `ashsilent:shuoshuo:${text}`, text }] });
    for (const full of [false, true]) {
      const output = await folder();
      await writeFile(path.join(output, "blog-sync.json"), JSON.stringify({ ...archive, entries: [entry, { ...entry, id: "ashsilent:shuoshuo:2" }, { ...entry, id: "ashsilent:shuoshuo:3" }] }));
      const fetch = vi.fn().mockResolvedValueOnce(new Response("1")).mockResolvedValueOnce(new Response("2")).mockResolvedValueOnce(new Response("3")).mockResolvedValueOnce(new Response("", { status: 404 }));
      const status = await runBlogSyncJob({ LIFE_SYNC_OUTPUT_DIR: output, BLOG_SYNC_FULL: String(full) }, { fetch, parseFeed: async text => make(text) });
      expect(status.state).toBe("ready");
      expect(fetch).toHaveBeenCalledTimes(full ? 4 : 2);
      const saved = JSON.parse(await readFile(path.join(output, "blog-sync.json"), "utf8"));
      expect(saved.entries.find((item: {id:string}) => item.id.endsWith(":3")).text).toBe(full ? "3" : "history");
    }
  });

});
