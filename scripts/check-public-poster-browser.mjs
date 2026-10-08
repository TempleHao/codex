import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// One fixed, public title. This check never opens a user's account or reads credentials.
const source = "https://images.metahub.space/poster/medium/tt1375666/img";
const base = "http://127.0.0.1:3200/codex/";
const binary = [process.env.CHROMIUM_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium"].find(path => path && existsSync(path));
if (!binary) throw new Error("A trusted installed Chromium or Google Chrome is required.");
const workerFile = "preview-out/media-posters-worker.js";
const currentWorker = await readFile(workerFile, "utf8");
const legacyWorker = currentWorker
  .replace(/^  if \(\/\^https:.*images.*metahub.*return value;\n/m, "")
  .replace(/^  if \(data\.type === "version"\).*\n/m, "");
if (legacyWorker === currentWorker || legacyWorker.includes("metahub") || legacyWorker.includes('data.type === "version"')) throw new Error("Legacy worker fixture was not isolated correctly.");
await writeFile(workerFile, legacyWorker);
const server = spawn(process.execPath, ["scripts/serve-preview.mjs"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LIFE_PREVIEW_PORT: "3200" } });
let serverError = "";
server.stderr.on("data", data => { serverError += data; });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await fetch(base, { signal: AbortSignal.timeout(500) })).ok; } catch { /* server startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error(`Preview failed to start: ${serverError.slice(0, 200)}`);
  browser = await chromium.launch({ executablePath: binary, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let workerDownloads = 0;
  let corsAttempts = 0;
  const errors = [];
  context.on("request", request => {
    if (request.url() === source) {
      if (request.serviceWorker()) workerDownloads++;
      else corsAttempts++;
    }
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("button", { name: "导出备份", exact: true }).waitFor();
  // Upgrade the same worker URL that an existing visitor already has installed.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("media-posters-worker.js", { scope: "./", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  });
  await writeFile(workerFile, currentWorker);
  await page.evaluate(poster => {
    const life = {
      reading: { version: 1, books: [], highlights: [], stats: null, syncedAt: null, source: "manual" },
      thoughts: [], board: { threads: [], observations: [], reviews: [] },
      media: { version: 1, source: "manual", syncedAt: null, entries: [{ id: "manual:public-network-probe", title: "公开海报加载检查", kind: "movie", status: "wanted", genres: [], history: [], imdbId: "tt1375666", poster }] },
    };
    localStorage.setItem("life-workbench-preview-v1", JSON.stringify({ version: 1, tasks: [], sources: [], batches: {}, life }));
  }, source);
  const openMedia = async () => {
    await page.reload();
    await page.getByRole("button", { name: "导出备份", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^影音/ }).click();
    await page.locator(".media-title").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".media-title-art img")];
      return images.length === 2 && images.every(image => image.naturalWidth > 0);
    }, undefined, { timeout: 45_000 });
  };
  await openMedia();
  const result = await page.locator(".media-title-art img").first().evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, route: image.src.startsWith("blob:") ? "blob" : "worker" }));
  const firstDownloads = workerDownloads;
  await openMedia();
  if (workerDownloads !== firstDownloads) throw new Error("The cached public poster was downloaded again after reload.");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow || errors.length) throw new Error("Mobile overflow or unhandled browser error.");
  console.log("::notice title=Public poster browser::" + JSON.stringify({ ...result, workerDownloads, corsAttempts, upgradedLegacyWorker: true, cacheReused: true, mobileOverflow: false, pageErrors: 0 }));
} catch (error) {
  console.error("::error title=Public poster browser::" + JSON.stringify({ error: error.message.slice(0, 500) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await writeFile(workerFile, currentWorker);
}
