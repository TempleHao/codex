import { readFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import type { WorkspaceData } from "../lib/types";

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
      target.on("console", message => { if (message.type() === "error") pageErrors.push(message.text()); });
      target.on("request", request => {
        if (/(?:^|\/)api(?:\/|$)/.test(new URL(request.url()).pathname)) apiCalls.push(`${request.method()} ${request.url()}`);
      });
      target.on("response", response => {
        if (response.status() >= 400) resourceErrors.push(`${response.status()} ${response.url()}`);
      });
      target.on("requestfailed", request => resourceErrors.push(`${request.failure()?.errorText} ${request.url()}`));
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
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function openWorkspace(page: Page) {
  await page.goto("./");
  await expect(page.getByRole("button", { name: "收集待办", exact: true })).toBeEnabled();
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
  await expect(page.getByRole("heading", { name: "今天还没有安排" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "收集待办", exact: true })).toBeEnabled();
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
  expect(backup).toMatchObject({ format: "life-workbench-backup", version: 1 });
  expect(backup.tasks).toEqual(saved.tasks);
  expect(backup.sources).toEqual(saved.sources);
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("待办和原文已清空");
  expect(await savedData(page)).toEqual({ tasks: [], sources: [] });
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { name: "今天还没有安排" })).toBeVisible();
  await page.getByLabel("选择待办备份文件").setInputFiles(filename!);
  await expect(page.getByRole("status")).toContainText("备份已恢复");
  expect(await savedData(page)).toEqual(saved);
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await page.getByLabel("选择待办备份文件").setInputFiles(filename!);
  await expect(page.getByRole("status")).toContainText("备份已恢复");
  expect(await savedData(page)).toEqual(saved);

  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    audit.watch(otherPage);
    await otherPage.goto(page.url());
    await expect(otherPage.getByRole("button", { name: "收集待办", exact: true })).toBeEnabled();
    await expect(otherPage.getByRole("heading", { name: "今天还没有安排" })).toBeVisible();
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
  await expect(page.getByRole("status")).toContainText("待办和原文已清空");
  expect(await savedData(page)).toEqual({ tasks: [], sources: [] });
  await expectNoHorizontalOverflow(page);
});
