import { optionalSnapshot } from "./snapshot-audit";
import { readFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import type { WorkspaceData } from "../lib/types";
import type { LifeData } from "../lib/life";

const STORAGE_KEY = "life-workbench-preview-v1";
type Audit = { watch: (page: Page) => void };

const test = base.extend<{ audit: Audit }>({
  audit: [async ({ page, context }, use) => {
    const apiCalls: string[] = [];
    const pageErrors: string[] = [];
    const resourceErrors: string[] = [];
    const watched = new Set<Page>();
    const watch = (target: Page) => {
      if (watched.has(target)) return;
      watched.add(target);
      target.on("pageerror", error => pageErrors.push(error.message));
      target.on("console", message => { if (message.type() === "error" && !(optionalSnapshot(message.location().url) && /Failed to load resource/.test(message.text()))) pageErrors.push(message.text()); });
      target.on("request", request => {
        const url = new URL(request.url());
        if (url.origin === new URL(target.url() || "http://127.0.0.1:3200").origin && /(?:^|\/)api(?:\/|$)/.test(url.pathname)) apiCalls.push(`${request.method()} ${request.url()}`);
      });
      target.on("response", response => {
        if (response.status() >= 400 && !(response.status() === 404 && optionalSnapshot(response.url()))) resourceErrors.push(`${response.status()} ${response.url()}`);
      });
      target.on("requestfailed", request => { if (!(optionalSnapshot(request.url()) && request.failure()?.errorText === "net::ERR_ABORTED")) resourceErrors.push(`${request.failure()?.errorText} ${request.url()}`); });
    };
    watch(page);
    context.on("page", watch);
    await use({ watch });
    expect(apiCalls, "静态版的浏览器不得请求服务器 API").toEqual([]);
    expect(pageErrors, "页面运行期间不得发生未处理的 JavaScript 错误").toEqual([]);
    expect(resourceErrors, "静态页面资源应正确加载").toEqual([]);
  }, { auto: true }],
});

async function savedData(page: Page): Promise<WorkspaceData> {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    if (raw === null) return { tasks: [], sources: [] };
    const value = JSON.parse(raw);
    return { tasks: value.tasks, sources: value.sources };
  }, STORAGE_KEY);
}

async function selectView(page: Page, name: string) {
  const taskNames = ["今天", "收件箱", "全部待办", "已完成"];
  const nav = page.getByRole("navigation", { name: "主导航" });
  if (taskNames.includes(name)) {
    await nav.getByRole("button", { name: /^事务/ }).click();
    await page.getByRole("navigation", { name: "事务视图" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
  } else await nav.getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function openWorkspace(page: Page) {
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect(page.locator(".preview-notice")).toContainText("数据仅保存在当前浏览器");
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
}

test("GitHub Pages 子路径首页、样式、图标和 manifest 均可访问", async ({ page, request }) => {
  await openWorkspace(page);
  await expect(page).toHaveURL("http://127.0.0.1:3200/codex/");
  const brand = page.getByRole("link", { name: "有序首页" });
  await expect(brand).toHaveAttribute("href", "/codex/");
  const assets = await page.locator('link[rel="stylesheet"], script[src]').evaluateAll(elements => elements.map(element => element.getAttribute("href") || element.getAttribute("src") || ""));
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) expect(new URL(asset, page.url()).pathname).toMatch(/^\/codex\/_next\//);
  const manifestPath = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestPath).toBe("/codex/manifest.webmanifest");
  const manifestURL = new URL(manifestPath!, page.url());
  const response = await request.get(manifestURL.href);
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(new URL(manifest.start_url, manifestURL).pathname).toBe("/codex/");
  expect(manifest.lang).toBe("zh-CN");
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    const iconURL = new URL(icon.src, manifestURL);
    expect(iconURL.pathname).toMatch(/^\/codex\//);
    const iconResponse = await request.get(iconURL.href);
    expect(iconResponse.status()).toBe(200);
    expect(iconResponse.headers()["content-type"]).toContain("image/");
  }
  const iconPath = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(new URL(iconPath!, page.url()).pathname).toMatch(/^\/codex\//);
  expect((await request.get(new URL(iconPath!, page.url()).href)).status()).toBe(200);
  await brand.click();
  await expect(page).toHaveURL("http://127.0.0.1:3200/codex/");
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^人生看板/ })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: "/tmp/life-pages-desktop.png", fullPage: true });
});

test("静态版聊天导入、刷新、完成、编辑、清空和备份恢复仅使用本浏览器数据", async ({ page, browser, audit }) => {
  test.setTimeout(60_000);
  const title = "整理测试资料并归档票据";
  const sourceText = "静态版测试原话：整理抽屉里的票据，还考虑买个新书架，书架先不安排。";
  await openWorkspace(page);
  expect(await savedData(page)).toEqual({ tasks: [], sources: [] });
  await selectView(page, "收件箱");
  await page.getByRole("button", { name: "收集待办", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("聊天整理结果").fill(JSON.stringify({ version: 1, sourceText, tasks: [
    { title: "整理票据", area: "生活", sourceExcerpt: "整理抽屉里的票据" },
    { title: "购买新书架", area: "生活", sourceExcerpt: "还考虑买个新书架" },
  ] }));
  await dialog.getByRole("button", { name: "生成待办预览" }).click();
  await expect(dialog.getByRole("checkbox", { name: "待办 01" })).toBeChecked();
  await dialog.locator("#draft-0-title").fill(title);
  await dialog.getByRole("checkbox", { name: "待办 02" }).uncheck();
  expect(await savedData(page)).toEqual({ tasks: [], sources: [] });
  await dialog.getByRole("button", { name: "确认保存 1 条" }).click();
  await expect(dialog).not.toBeVisible();
  let saved = await savedData(page);
  expect(saved.tasks).toHaveLength(1);
  expect(saved.sources).toHaveLength(1);
  expect(saved.tasks[0]).toMatchObject({ title, status: "todo", sourceExcerpt: "整理抽屉里的票据" });
  expect(saved.tasks[0].sourceId).toBe(saved.sources[0].id);
  expect(saved.sources[0].text).toBe(sourceText);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await selectView(page, "全部待办");
  await page.getByRole("button", { name: `完成：${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `完成：${title}`, exact: true })).not.toBeVisible();
  saved = await savedData(page);
  expect(saved.tasks[0].status).toBe("done");
  expect(saved.tasks[0].completedAt).not.toBeNull();
  await selectView(page, "已完成");
  await page.getByRole("button", { name: `撤销完成：${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `撤销完成：${title}`, exact: true })).not.toBeVisible();
  saved = await savedData(page);
  expect(saved.tasks[0].status).toBe("todo");
  expect(saved.tasks[0].completedAt).toBeNull();
  await selectView(page, "全部待办");
  await page.getByRole("button", { name: `查看详情：${title}`, exact: true }).click();
  await page.getByRole("button", { name: "编辑待办", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("计划日期", { exact: true }).fill("2099-06-15");
  await dialog.getByLabel("备注", { exact: true }).fill("票据分类后放入收纳盒");
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  saved = await savedData(page);
  expect(saved.tasks[0]).toMatchObject({ plannedDate: "2099-06-15", notes: "票据分类后放入收纳盒" });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const download = await downloadPromise;
  const filename = await download.path();
  expect(filename).not.toBeNull();
  const backup = JSON.parse(await readFile(filename!, "utf8")) as WorkspaceData & { format: string; version: number };
  expect(backup).toMatchObject({ format: "life-workbench-backup", version: 2 });
  expect(backup.tasks).toEqual(saved.tasks);
  expect(backup.sources).toEqual(saved.sources);
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("原文和海报缓存已清空");
  expect(await savedData(page)).toEqual({ tasks: [], sources: [] });
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^人生看板/ })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("选择完整备份文件").setInputFiles(filename!);
  await expect(page.getByRole("status")).toContainText("备份已恢复");
  expect(await savedData(page)).toEqual(saved);
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.getByLabel("选择完整备份文件").setInputFiles(filename!);
  await expect(page.getByRole("status")).toContainText("备份已恢复");
  expect(await savedData(page)).toEqual(saved);

  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    audit.watch(otherPage);
    await otherPage.goto(page.url());
    await expect(otherPage.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
    await expect(otherPage.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^人生看板/ })).toHaveAttribute("aria-current", "page");
    expect(await savedData(otherPage)).toEqual({ tasks: [], sources: [] });
    expect(await savedData(page)).toEqual(saved);
  } finally { await otherContext.close(); }
});

test("静态版手机视口可以收集、编辑和清空，页面无横向滚动", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/life-pages-mobile.png", fullPage: true });
  const title = "手机静态测试：整理钥匙、雨伞和快递票据";
  await selectView(page, "收件箱");
  await page.getByRole("button", { name: "收集待办", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("聊天整理结果").fill(JSON.stringify({ version: 1, sourceText: "测试原话：把玄关杂物收起来", tasks: [{ title, area: "生活", sourceExcerpt: "把玄关杂物收起来" }] }));
  await dialog.getByRole("button", { name: "生成待办预览" }).click();
  await expect(dialog.getByRole("checkbox", { name: "待办 01" })).toBeChecked();
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "确认保存 1 条" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: `查看详情：${title}`, exact: true }).click();
  await page.getByRole("button", { name: "编辑待办", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("备注", { exact: true }).fill("放入玄关收纳盒");
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await savedData(page)).tasks[0].notes).toBe("放入玄关收纳盒");
  await expectNoHorizontalOverflow(page);
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("原文和海报缓存已清空");
  expect(await savedData(page)).toEqual({ tasks: [], sources: [] });
  await expectNoHorizontalOverflow(page);
});

test("阅读与思考独立保存，可选事务工具和完整备份仍可使用", async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await selectView(page, "阅读");
  await page.getByRole("button", { name: "导入阅读 JSON", exact: true }).click();
  const library = {
    version: 1, source: "manual", items: [{ id: "book-test", title: "把想法带进生活", author: "测试作者", kind: "ebook", status: "reading", progress: 1, secondsRead: 3660 }],
    highlights: [{ id: "highlight-test", bookId: "book-test", text: "把长期的方向变成今天能够做的一小步。", chapter: "从思考到行动" }],
    stats: { totalSeconds: 7200, readingDays: 2, mode: "overall", period: null, dailySeconds: [{ date: "2026-10-01", seconds: 3600 }, { date: "2026-10-02", seconds: 0 }] }, syncedAt: null,
  };
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("阅读资料 JSON", { exact: true }).fill(JSON.stringify(library));
  await dialog.getByRole("button", { name: "预览资料", exact: true }).click();
  expect((await savedData(page)).tasks).toHaveLength(0);
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".reading-book-facts")).toContainText("1%");
  await expect(page.locator(".reading-heatmap")).toHaveAttribute("aria-label", /2026年已导入2天/);
  await expect(page.locator(".reading-heat-missing")).not.toHaveCount(0);
  const highlight = page.locator(".reading-highlight").filter({ hasText: library.highlights[0].text });
  await highlight.getByRole("button", { name: /思考/ }).click();
  await expect(page.getByLabel(/^原摘录/)).toHaveValue(library.highlights[0].text);
  expect((await savedData(page)).tasks).toHaveLength(0);
  await page.getByLabel("思考标题", { exact: true }).fill("周末整理我的生活计划");
  await page.getByLabel("我的想法", { exact: true }).fill("先把健康、家务和阅读安排到一周里，留一些空白。");
  await page.getByRole("button", { name: "保存思考", exact: true }).click();
  await page.getByRole("article", { name: "周末整理我的生活计划", exact: true }).getByText("事务工具", { exact: true }).click();
  await page.getByRole("button", { name: "转为待办：周末整理我的生活计划", exact: true }).click();
  const taskDialog = page.getByRole("dialog");
  await expect(taskDialog.getByLabel("要做什么", { exact: true })).toHaveValue("周末整理我的生活计划");
  expect((await savedData(page)).tasks).toHaveLength(0);
  await taskDialog.getByRole("button", { name: "保存待办", exact: true }).click();
  await expect(taskDialog).not.toBeVisible();
  const saved = await savedData(page);
  expect(saved.tasks).toHaveLength(1);
  expect(saved.tasks[0].notes).toContain(library.highlights[0].text);
  const life = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).life as LifeData, STORAGE_KEY);
  expect(life.reading.books).toHaveLength(1);
  expect(life.thoughts[0]).toMatchObject({ title: "周末整理我的生活计划", bookId: "book-test", highlightId: "highlight-test", sourceExcerpt: library.highlights[0].text });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const backupPath = await (await downloadPromise).path();
  const backup = JSON.parse(await readFile(backupPath!, "utf8"));
  expect(backup.version).toBe(2);
  expect(backup.life).toEqual(life);
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.locator(".feedback")).toContainText("原文和海报缓存已清空");
  await page.getByLabel("选择完整备份文件").setInputFiles(backupPath!);
  await expect(page.getByRole("status").first()).toContainText("备份已恢复");
  expect(await savedData(page)).toEqual(saved);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).life, STORAGE_KEY)).toEqual(life);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ["阅读", "思考", "人生看板"]) {
    await selectView(page, view);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `/tmp/life-${view === "阅读" ? "reading" : view === "思考" ? "thoughts" : "overview"}-mobile.png`, fullPage: true });
  }
});
