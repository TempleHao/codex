import { readFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import { emptyLifeData, type LifeData } from "../lib/life";
import { encryptReadingLibrary, type ReadingEnvelope } from "../lib/reading-envelope";
import { readingLibrarySchema, type ReadingLibrary } from "../lib/reading";
import type { ReadingSyncStatus } from "../lib/reading-sync-status";

const STORAGE_KEY = "life-workbench-preview-v1";
const PASSPHRASE = "test-only-random-long-reading-passphrase-2026";
const UPDATED_AT = "2026-10-08T04:00:00.000Z";
type StoredWorkspace = { version: 1; tasks: unknown[]; sources: unknown[]; batches: Record<string, unknown>; life: LifeData };
type SyncStatus = ReadingSyncStatus;

const test = base.extend<{ audit: void }>({
  audit: [async ({ page }, use) => {
    const forbiddenRequests: string[] = [];
    const pageErrors: string[] = [];
    const resourceErrors: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      if ((url.hostname !== "127.0.0.1" && url.hostname !== "localhost") || /(?:^|\/)api(?:\/|$)/.test(url.pathname)) {
        forbiddenRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      }
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") pageErrors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) resourceErrors.push(`${response.status()} ${response.url()}`); });
    page.on("requestfailed", request => resourceErrors.push(`${request.failure()?.errorText} ${request.url()}`));
    await use();
    expect(forbiddenRequests, "网页同步只下载本站文件，不调用官方接口或后台 API").toEqual([]);
    expect(pageErrors, "解锁与确认流程不应发生未处理的页面错误").toEqual([]);
    expect(resourceErrors, "页面静态资源与同步文件均应成功加载").toEqual([]);
  }, { auto: true }],
});

function originalState(): StoredWorkspace {
  const life = emptyLifeData();
  life.reading = readingLibrarySchema.parse({
    version: 1, source: "manual", syncedAt: "2025-12-31T12:00:00.000Z",
    books: [
      { id: "older-book", title: "保留手动添加的旧书", author: "旧作者", kind: "ebook", status: "finished" },
      { id: "shared-book", title: "更新前的书名", author: "", kind: "ebook", status: "reading", progress: 12 },
    ],
    highlights: [{ id: "older-note", bookId: "older-book", text: "以前导入的笔记应当继续保留。" }],
    stats: { totalSeconds: 7200, readingDays: 1, dailySeconds: [{ date: "2025-12-31", seconds: 3600 }, { date: "2026-10-08", seconds: 60 }], mode: "overall", period: null },
  });
  const threadId = "11111111-1111-4111-8111-111111111111";
  life.board = {
    threads: [{ id: threadId, title: "独立保留的生活兴趣", area: "阅读", kind: "interest", state: "active", description: "生活不以待办为纲领。", createdAt: UPDATED_AT, updatedAt: UPDATED_AT }],
    observations: [{ id: "22222222-2222-4222-8222-222222222222", threadId, area: "阅读", kind: "feeling", text: "今天阅读时感到平静。", date: "2026-10-08", createdAt: UPDATED_AT }],
    reviews: [{ id: "33333333-3333-4333-8333-333333333333", title: "回看自己的变化", date: "2026-10-08", noticed: "在安静中看见自己。", changed: "", keep: "", createdAt: UPDATED_AT }],
  };
  life.thoughts = [{ id: "44444444-4444-4444-8444-444444444444", title: "独立思考不被同步覆盖", body: "这段记录只留在浏览器里。", createdAt: UPDATED_AT, updatedAt: UPDATED_AT }];
  return { version: 1, tasks: [], sources: [], batches: {}, life };
}

function synchronizedLibrary(): ReadingLibrary {
  return readingLibrarySchema.parse({
    version: 1, source: "weread", syncedAt: UPDATED_AT,
    books: [
      { id: "shared-book", title: "从微信读书同步的新书名", author: "同步作者", kind: "ebook", status: "finished", progress: 100, secondsRead: 5400 },
      { id: "new-book", title: "慢慢理解自己的阅读与生活", author: "同步作者", kind: "ebook", status: "reading", progress: 25 },
    ],
    highlights: [{ id: "new-note", bookId: "new-book", text: "留下阅读痕迹，也允许它没有结论。", thought: "这一次我想停下来看看自己的感受。" }],
    stats: { totalSeconds: 14400, readingDays: 2, dailySeconds: [{ date: "2026-10-08", seconds: 5400 }], mode: "overall", period: null },
  });
}

async function rawStorage(page: Page): Promise<string | null> {
  return page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
}

async function persisted(page: Page): Promise<StoredWorkspace | null> {
  const raw = await rawStorage(page);
  return raw === null ? null : JSON.parse(raw);
}

async function openReading(page: Page, seed?: StoredWorkspace) {
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  if (seed) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: STORAGE_KEY, value: seed });
    await page.reload();
    await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  }
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^阅读/ }).click();
  await page.getByText("微信读书同步", { exact: true }).click();
  await expect(page.getByLabel("同步资料解锁口令", { exact: true })).toBeVisible();
}

async function mockSync(page: Page, options: { envelope?: ReadingEnvelope; status?: SyncStatus } = {}) {
  const data = {
    envelope: options.envelope ?? await encryptReadingLibrary(synchronizedLibrary(), PASSPHRASE),
    status: options.status ?? { version: 1, state: "ready", updatedAt: UPDATED_AT } as SyncStatus,
    requests: [] as string[],
  };
  await page.route("**/weread-sync*.json*", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    data.requests.push(pathname);
    expect(request.method()).toBe("GET");
    expect(request.headers()["authorization"]).toBeUndefined();
    expect(pathname).toMatch(/^\/codex\/weread-sync(?:-status)?\.json$/);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(pathname.endsWith("weread-sync-status.json") ? data.status : data.envelope),
    });
  });
  return data;
}

async function unlock(page: Page, passphrase = PASSPHRASE) {
  await page.getByLabel("同步资料解锁口令", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "读取同步资料", exact: true }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
}

test("下载本站密文后真实解锁，确认前不写入，确认合并保留旧阅读、看板和思考", async ({ page }) => {
  test.setTimeout(60_000);
  const before = originalState();
  const sync = await mockSync(page);
  expect(JSON.stringify(sync.envelope)).not.toContain(synchronizedLibrary().books[0].title);
  expect(JSON.stringify(sync.envelope)).not.toContain(PASSPHRASE);
  await openReading(page, before);
  const rawBefore = await rawStorage(page);
  await expect(page.getByLabel("微信读书 API Key", { exact: true })).toHaveCount(0);
  await unlock(page);
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  await expect(page.getByLabel("同步资料解锁口令", { exact: true })).toHaveCount(0);
  await expect(page.locator(".weread-sync")).toContainText(synchronizedLibrary().books[0].title);
  expect(await rawStorage(page)).toBe(rawBefore);
  expect(sync.requests).toContain("/codex/weread-sync.json");
  expect(sync.requests).toContain("/codex/weread-sync-status.json");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/life-weread-github-sync-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "保存到阅读", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).not.toBeVisible();
  const after = await persisted(page);
  expect(after?.life.board).toEqual(before.life.board);
  expect(after?.life.thoughts).toEqual(before.life.thoughts);
  expect(after?.tasks).toEqual([]);
  expect(after?.sources).toEqual([]);
  expect(after?.life.reading.books.map(book => book.id)).toEqual(["older-book", "shared-book", "new-book"]);
  expect(after?.life.reading.books[1]).toEqual(synchronizedLibrary().books[0]);
  expect(after?.life.reading.highlights.map(note => note.id)).toEqual(["older-note", "new-note"]);
  expect(after?.life.reading.stats).toMatchObject({ totalSeconds: 14400, readingDays: 2, dailySeconds: [{ date: "2025-12-31", seconds: 3600 }, { date: "2026-10-08", seconds: 5400 }] });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const backupPath = await (await downloadPromise).path();
  const backupText = await readFile(backupPath!, "utf8");
  expect(backupText).not.toContain(PASSPHRASE);
  expect(backupText).not.toContain("WEREAD_API_KEY");
  expect(JSON.parse(backupText).life).toEqual(after?.life);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^阅读/ }).click();
  await page.getByText("微信读书同步", { exact: true }).click();
  await expect(page.getByLabel("同步资料解锁口令", { exact: true })).toHaveValue("");
  expect((await persisted(page))?.life).toEqual(after?.life);
  await expectNoHorizontalOverflow(page);
});

test("错误口令或被修改的密文都拒绝预览，不修改已有记录或保存解锁口令", async ({ page }) => {
  const sync = await mockSync(page);
  await openReading(page, originalState());
  const before = await rawStorage(page);
  await unlock(page, "test-only-an-incorrect-random-passphrase");
  await expect(page.locator(".weread-sync-error")).toContainText("解锁没有完成");
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).not.toBeVisible();
  await expect(page.getByLabel("同步资料解锁口令", { exact: true })).toHaveValue("");
  expect(await rawStorage(page)).toBe(before);
  const initial = sync.envelope.ciphertext[0];
  sync.envelope = { ...sync.envelope, ciphertext: `${initial === "A" ? "B" : "A"}${sync.envelope.ciphertext.slice(1)}` };
  await unlock(page);
  await expect(page.locator(".weread-sync-error")).toContainText("解锁没有完成");
  await expect(page.getByRole("button", { name: "保存到阅读", exact: true })).not.toBeVisible();
  expect(await rawStorage(page)).toBe(before);
  expect(await rawStorage(page)).not.toContain(PASSPHRASE);
});

test("关闭、离开阅读和刷新均清空未提交口令，放弃预览不修改本机资料", async ({ page }) => {
  await mockSync(page);
  await openReading(page, originalState());
  const before = await rawStorage(page);
  const password = page.getByLabel("同步资料解锁口令", { exact: true });
  await password.fill(PASSPHRASE);
  await page.getByRole("button", { name: "关闭同步", exact: true }).click();
  await page.getByText("微信读书同步", { exact: true }).click();
  await expect(password).toHaveValue("");
  await password.fill(PASSPHRASE);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^思考/ }).click();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^阅读/ }).click();
  await page.getByText("微信读书同步", { exact: true }).click();
  await expect(password).toHaveValue("");
  await password.fill(PASSPHRASE);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^阅读/ }).click();
  await page.getByText("微信读书同步", { exact: true }).click();
  await expect(password).toHaveValue("");
  await unlock(page);
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "放弃预览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).not.toBeVisible();
  expect(await rawStorage(page)).toBe(before);
});

test("存储不足保留解锁预览和旧数据，恢复空间后可重试确认", async ({ page }) => {
  await mockSync(page);
  await openReading(page, originalState());
  const before = await rawStorage(page);
  await unlock(page);
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    const target = window as typeof window & { readingSyncQuotaExceeded?: boolean };
    target.readingSyncQuotaExceeded = true;
    Storage.prototype.setItem = function (storageKey: string, value: string) {
      if (storageKey === key && target.readingSyncQuotaExceeded) throw new DOMException("Synthetic test quota", "QuotaExceededError");
      return original.call(this, storageKey, value);
    };
  }, STORAGE_KEY);
  await page.getByRole("button", { name: "保存到阅读", exact: true }).click();
  await expect(page.locator(".weread-sync-error")).toContainText("预览仍在这里");
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存到阅读", exact: true })).toBeEnabled();
  expect(await rawStorage(page)).toBe(before);
  await page.evaluate(() => { (window as typeof window & { readingSyncQuotaExceeded?: boolean }).readingSyncQuotaExceeded = false; });
  await page.getByRole("button", { name: "保存到阅读", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).not.toBeVisible();
  expect((await persisted(page))?.life.reading.books).toHaveLength(3);
  expect((await persisted(page))?.life.board).toEqual(originalState().life.board);
});

test("未配置状态展示 GitHub Secrets 入口，网页没有 API Key 输入，也不读取官方接口", async ({ page }) => {
  const sync = await mockSync(page, { status: { version: 1, state: "needs_setup", updatedAt: UPDATED_AT, failureCode: "configuration_missing" } });
  await openReading(page);
  await page.getByText("首次配置同步", { exact: true }).click();
  await expect(page.getByRole("link", { name: /Secrets/ })).toHaveAttribute("href", "https://github.com/TempleHao/codex/settings/secrets/actions");
  await expect(page.getByLabel("微信读书 API Key", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "查看同步状态", exact: true }).click();
  await expect(page.locator(".weread-sync")).toContainText("请先完成首次配置");
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).not.toBeVisible();
  expect(sync.requests.filter(path => path.endsWith("/weread-sync.json"))).toEqual([]);
  expect(await rawStorage(page)).toBeNull();
});

test("本次同步失败但保留旧快照时明确显示状态，仍须解锁与确认", async ({ page }) => {
  await mockSync(page, { status: { version: 1, state: "preserved", updatedAt: UPDATED_AT, failureCode: "network_error" } });
  await openReading(page);
  await unlock(page);
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  await expect(page.locator(".weread-sync")).toContainText(/保留|旧资料|上次/);
  expect(await rawStorage(page)).toBeNull();
});

test("浏览器生成随机长口令供首次配置，关闭配置即清除，不进入个人记录", async ({ page }) => {
  await openReading(page, originalState());
  const before = await rawStorage(page);
  await page.getByText("首次配置同步", { exact: true }).click();
  await page.getByRole("button", { name: "生成随机口令", exact: true }).click();
  const generated = page.getByLabel("本次生成的同步口令", { exact: true });
  await expect(generated).toBeVisible();
  const value = await generated.inputValue();
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await rawStorage(page)).toBe(before);
  expect(await rawStorage(page)).not.toContain(value);
  await page.getByText("首次配置同步", { exact: true }).click();
  await expect(generated).toHaveValue("");
  await page.getByText("首次配置同步", { exact: true }).click();
  await expect(generated).not.toBeVisible();
  await page.getByRole("button", { name: "生成随机口令", exact: true }).click();
  await expect(generated).toBeVisible();
  expect(await generated.inputValue()).not.toBe(value);
  await page.getByRole("button", { name: "关闭同步", exact: true }).click();
  await page.getByText("微信读书同步", { exact: true }).click();
  await expect(generated).toHaveValue("");
  expect(await rawStorage(page)).toBe(before);
});
