import { z } from "zod";

export const BLOG_SOURCE_URL = "https://www.ashsilent.com/";
const httpUrl = z.string().max(4096).url().refine(value => ["http:", "https:"].includes(new URL(value).protocol));
export function isBlogSourceUrl(value: string, sayingsOnly = false): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.ashsilent.com" && !url.username && !url.password && (!url.port || url.port === "443") && (!sayingsOnly || /^\/shuoshuo\/[^/]+\/?$/.test(url.pathname));
  } catch { return false; }
}
export const blogEntrySchema = z.object({
  id: z.string().regex(/^ashsilent:shuoshuo:(?:\d+|guid-[a-f0-9]{24})$/),
  sourceUrl: httpUrl.refine(value => isBlogSourceUrl(value, true)),
  date: z.iso.datetime({ offset: true }),
  text: z.string().max(100000),
  title: z.string().max(2000).default(""),
  author: z.string().max(1000).default(""),
  images: z.array(z.object({ url: httpUrl, alt: z.string().max(2000).default("") })).max(100).default([]),
  media: z.array(z.object({ url: httpUrl, kind: z.enum(["iframe", "audio", "video", "source"]), title: z.string().max(2000).optional() })).max(100).default([]),
  links: z.array(httpUrl).max(1000).default([]),
});
export const blogArchiveSchema = z.object({
  version: z.literal(1), sourceUrl: z.literal(BLOG_SOURCE_URL), updatedAt: z.iso.datetime({ offset: true }),
  entries: z.array(blogEntrySchema).max(100000),
}).refine(value => new Set(value.entries.map(entry => entry.id)).size === value.entries.length, "Duplicate blog identifiers");
export type BlogEntry = z.infer<typeof blogEntrySchema>;
export type BlogArchive = z.infer<typeof blogArchiveSchema>;
export function normalizeBlogArchive(value: unknown): BlogArchive {
  const archive = blogArchiveSchema.parse(value);
  return { ...archive, entries: [...archive.entries].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id)) };
}
/** Incoming revisions replace matching entries; missing upstream records never delete history. */
export function mergeBlogArchives(before: BlogArchive, incoming: BlogArchive): BlogArchive {
  const old = normalizeBlogArchive(before);
  const next = normalizeBlogArchive(incoming);
  const entries = new Map(old.entries.map(entry => [entry.id, entry]));
  for (const entry of next.entries) entries.set(entry.id, entry);
  return normalizeBlogArchive({ ...next, entries: [...entries.values()] });
}
