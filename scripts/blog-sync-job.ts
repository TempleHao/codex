import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BLOG_SOURCE_URL, blogArchiveSchema, blogEntrySchema, isBlogSourceUrl, mergeBlogArchives, normalizeBlogArchive } from "../lib/blog";
import type { BlogArchive, BlogEntry } from "../lib/blog";

export const BLOG_SYNC_FILENAME = "blog-sync.json";
export const BLOG_PREVIOUS_URL = "https://templehao.github.io/codex/blog-sync.json";
const MAX_BYTES = 30_000_000;
type Env = Record<string, string | undefined>;
export interface BlogSyncStatus { version: 1; state: "ready" | "preserved" | "failed"; updatedAt: string; failureCode?: "upstream_failed"; }
export interface BlogSyncDependencies {
  fetch?: typeof fetch; now?: () => Date; parseFeed?: (xml: string) => Promise<{itemCount: number; entries: BlogEntry[]}>;
  writeAtomic?: (filename: string, contents: string) => Promise<void>;
}
async function atomicWrite(filename: string, contents: string) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try { await writeFile(temp, contents, { flag: "wx", mode: 0o600 }); await rename(temp, filename); }
  finally { await rm(temp, { force: true }); }
}
export async function parseBlogFeed(xml: string): Promise<{itemCount: number; entries: BlogEntry[]}> {
  const value = await new Promise<string>((resolve, reject) => {
    const child = spawn("python3", [path.resolve("scripts/parse-blog-feed.py")], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; if (output.length > MAX_BYTES) child.kill(); });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error("RSS parsing failed")));
    child.stdin.on("error", () => {});
    child.stdin.end(xml);
  });
  return z.object({ itemCount: z.number().int().nonnegative().max(100), entries: z.array(blogEntrySchema).max(100) }).parse(JSON.parse(value));
}
async function boundedText(response: Response, maximum: number) {
  if (!response.body) throw new Error("Empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error("Response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export async function runBlogSyncJob(env: Env = process.env, dependencies: BlogSyncDependencies = {}): Promise<BlogSyncStatus> {
  const transport = dependencies.fetch ?? fetch;
  const output = path.resolve(env.LIFE_SYNC_OUTPUT_DIR || "preview-out");
  const persist = dependencies.writeAtomic ?? atomicWrite;
  const updatedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  await mkdir(output, { recursive: true });
  let previous: BlogArchive | undefined;
  try { previous = normalizeBlogArchive(JSON.parse(await readFile(path.join(output, BLOG_SYNC_FILENAME), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Previous blog snapshot invalid"); }
  // Even a fresh build must recover prior history; any uncertainty blocks deployment.
  if (!previous) {
    const response = await transport(BLOG_PREVIOUS_URL, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) await response.body?.cancel();
    else {
      if (!response.ok || response.url && response.url !== BLOG_PREVIOUS_URL) throw new Error("Previous blog snapshot unavailable");
      previous = normalizeBlogArchive(JSON.parse(await boundedText(response, MAX_BYTES)));
    }
  }
  let archive = previous;
  let status: BlogSyncStatus;
  try {
    const oldIds = new Set(previous?.entries.map(entry => entry.id));
    const entries = new Map<string, BlogEntry>();
    const parseFeed = dependencies.parseFeed ?? parseBlogFeed;
    let complete = false, overlapPages = 0;
    // Sequential requests intentionally stay below the upstream concurrency limit of two.
    for (let page = 1; page <= 1000; page++) {
      const response = await transport(`${BLOG_SOURCE_URL}feed?paged=${page}`, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 404 && page > 1) { await response.body?.cancel(); complete = true; break; }
      if (!response.ok || response.url && !isBlogSourceUrl(response.url)) throw new Error("Feed unavailable");
      const parsed = await parseFeed(await boundedText(response, 2_000_000));
      if (!parsed.itemCount) { if (page === 1) throw new Error("Unexpected empty feed"); complete = true; break; }
      if (parsed.entries.some(entry => oldIds.has(entry.id))) overlapPages++; else overlapPages = 0;
      let added = 0;
      for (const entry of parsed.entries) { if (!entries.has(entry.id)) added++; entries.set(entry.id, entry); }
      if (parsed.entries.length && !added) throw new Error("Feed pagination repeated");
      if (previous && env.BLOG_SYNC_FULL !== "true" && overlapPages >= 2) { complete = true; break; }
    }
    if (!complete || !entries.size) throw new Error("Incomplete feed");
    const incoming = normalizeBlogArchive({ version: 1, sourceUrl: BLOG_SOURCE_URL, updatedAt, entries: [...entries.values()] });
    archive = previous ? mergeBlogArchives(previous, incoming) : incoming;
    status = { version: 1, state: "ready", updatedAt };
  } catch {
    status = { version: 1, state: previous ? "preserved" : "failed", updatedAt, failureCode: "upstream_failed" };
  }
  if (archive) await persist(path.join(output, BLOG_SYNC_FILENAME), JSON.stringify(blogArchiveSchema.parse(archive)));
  await persist(path.join(output, "blog-sync-status.json"), JSON.stringify(status));
  return status;
}
export async function runBlogSyncCli(env: Env = process.env): Promise<boolean> {
  try {
    const status = await runBlogSyncJob(env);
    const summary = `Blog synchronization: ${status.state}. ${status.state === "preserved" ? "Previous public archive retained." : status.state === "failed" ? "No partial archive published." : "Public archive updated."}`;
    console.log(summary);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    return true;
  } catch {
    console.error("Previous blog archive could not be safely recovered or written. Deployment stopped to preserve history.");
    return false;
  }
}
