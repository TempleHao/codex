import { test, writePreviewWorkspace } from "./preview-fixtures";
import { expect, type Page } from "@playwright/test";
import { emptyLifeData } from "../lib/life";
import type { ReadingHighlight } from "../lib/reading";

const KEY = "life-workbench-preview-v1";
const BOOK = { id: "book-b", title: "回看自己的阅读", author: "测试作者", kind: "ebook" as const, status: "finished" as const };
const NOTES: ReadingHighlight[] = [
  { id: "quote-1", bookId: BOOK.id, text: "允许一个疑问，暂时没有答案。", chapter: "关于好奇心", createdAt: "2026-10-08" },
  { id: "thought-2", bookId: BOOK.id, text: "", thought: "我想给生活留一些慢慢理解的空间。" },
  { id: "both-3", bookId: BOOK.id, text: "停下来，看看自己走过的路。", thought: "读到这里，想起那次散步。" },
];

async function open(page: Page, notes = NOTES) {
  const life = emptyLifeData();
  life.reading = { ...life.reading, books: [{ ...BOOK, id: "book-a", title: "另一本文字" }, BOOK], highlights: notes };
  const seed = { version: 1, tasks: [], sources: [], batches: {}, life };
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await writePreviewWorkspace(page, seed);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  return saved(page);
}
async function saved(page: Page) { return page.evaluate(key => localStorage.getItem(key), KEY); }
async function view(page: Page, name: string) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
}
function card(page: Page) { return page.getByRole("region", { name: "偶然重逢", exact: true }); }

test("首页随机回顾在阅读页保持一致，换一条不重复并能定位原笔记", async ({ page }) => {
  const original = await open(page);
  await expect(card(page)).toContainText(NOTES[0].text);
  await expect(card(page)).toContainText(BOOK.title);
  await view(page, "阅读");
  await expect(card(page)).toContainText(NOTES[0].text);
  await card(page).getByRole("button", { name: "换一条", exact: true }).click();
  await expect(card(page)).toContainText(NOTES[1].thought!);
  await card(page).getByRole("button", { name: "换一条", exact: true }).click();
  await expect(card(page)).toContainText(NOTES[2].thought!);
  await card(page).getByText("回看当时的划线", { exact: true }).click();
  await expect(card(page).locator(".revisit-excerpt blockquote")).toBeVisible();
  await expect(card(page)).toContainText(NOTES[2].text);
  await card(page).getByRole("button", { name: "划线", exact: true }).click();
  await expect(card(page).locator(".revisit-quote")).toHaveText(NOTES[0].text);
  await page.getByPlaceholder("搜索书名或作者", { exact: true }).fill("不存在的书名");
  await card(page).getByRole("button", { name: "查看这条笔记", exact: true }).click();
  await expect(page.getByPlaceholder("搜索书名或作者", { exact: true })).toHaveValue("");
  const target = page.locator('[id="reading-note-quote-1"]');
  await expect(target).toBeFocused();
  await expect(page.locator(".reading-detail-title h2")).toHaveText(BOOK.title);
  await expect(target.locator("blockquote")).toHaveText(NOTES[0].text);
  await view(page, "人生看板");
  await expect(card(page).getByRole("button", { name: "划线", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toBe(original);
  expect(await page.evaluate(() => localStorage.length)).toBe(1);
});

test("只有想法和长内容可阅读，过滤为空可切回，手机与电脑无溢出或记录改写", async ({ page }) => {
  const thought = "想慢慢理解的事情。".repeat(65) + "<script>这里也是原文</script>";
  const original = await open(page, [{ id: "long-thought", bookId: BOOK.id, text: "", thought }]);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await expect(card(page).locator(".revisit-thought")).not.toHaveText(thought);
  await expect(card(page).getByRole("button", { name: "只有这一条" })).toBeDisabled();
  await card(page).getByRole("button", { name: "展开全文", exact: true }).click();
  await expect(card(page).locator(".revisit-thought")).toHaveText(thought);
  await expect(card(page).locator(".revisit-excerpt")).toHaveCount(0);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await card(page).getByRole("button", { name: "划线", exact: true }).click();
  await expect(card(page)).toContainText("还没有保存划线原文");
  await card(page).getByRole("button", { name: "我的想法", exact: true }).click();
  await expect(card(page).locator(".revisit-thought")).toBeVisible();
  await card(page).getByRole("button", { name: "查看这条笔记", exact: true }).click();
  await expect(page.locator('[id="reading-note-long-thought"]')).toBeFocused();
  await expect(page.getByRole("tab", { name: /本人想法/ })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(card(page).getByRole("button", { name: "都看看", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await saved(page)).toBe(original);
  expect(errors).toEqual([]);
});

test("无笔记时首页不制造内容，导入确认后立即出现回顾，清空后撤下旧笔记", async ({ page }) => {
  await open(page, []);
  await expect(card(page)).toHaveCount(0);
  await view(page, "阅读");
  await expect(page.getByLabel("阅读回顾提示")).toBeVisible();
  await page.getByRole("button", { name: "导入阅读 JSON", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("阅读资料 JSON", { exact: true }).fill(JSON.stringify({ version: 1, source: "manual", items: [BOOK], highlights: [NOTES[0]], stats: null, syncedAt: null }));
  await dialog.getByRole("button", { name: "预览资料", exact: true }).click();
  await expect(page.getByLabel("阅读回顾提示")).toBeVisible();
  await dialog.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(card(page)).toContainText(NOTES[0].text);
  await view(page, "人生看板");
  await expect(card(page)).toContainText(NOTES[0].text);
  page.once("dialog", async dialog => dialog.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await view(page, "阅读");
  await expect(page.getByLabel("阅读回顾提示")).toBeVisible();
});
