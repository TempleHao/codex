import { expect, test, type Page } from "@playwright/test";
import { emptyLifeData } from "../lib/life";
import type { BlogArchive } from "../lib/blog";

const KEY = "life-workbench-preview-v1";
const LOCAL_ID = "11111111-1111-4111-8111-111111111111";
const archive: BlogArchive = {
  version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-10-09T00:00:00Z",
  entries: Array.from({ length: 85 }, (_, index) => ({
    id: `ashsilent:shuoshuo:${index + 1}`, sourceUrl: `https://www.ashsilent.com/shuoshuo/${index + 1}/`,
    date: new Date(Date.UTC(2025, 0, 85 - index)).toISOString(), title: `旧文字 ${index + 1}`, author: "测试作者",
    text: index === 0 ? "慢慢想清楚。".repeat(120) + "<script>原文只是文字</script>" : `这是第 ${index + 1} 条测试感受。`,
    images: [], media: [], links: [],
  })),
};
async function open(page: Page) {
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: archive }));
  await page.addInitScript(() => { Math.random = () => 0; });
  const life = emptyLifeData();
  life.thoughts = [{ id: LOCAL_ID, title: "今天随手写", body: "一个属于今天的疑问。", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }];
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await page.evaluate(({ key, life }) => localStorage.setItem(key, JSON.stringify({ version: 1, tasks: [], sources: [], batches: {}, life })), { key: KEY, life });
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^思考/ }).click();
  await expect(page.locator(".thoughts-blog-card").first()).toBeVisible();
}
test("统一时间线按原日期排列，分页和来源年份搜索不改写记录", async ({ page }) => {
  await open(page);
  await expect(page.locator(".thoughts-list>.thoughts-card")).toHaveCount(40);
  await expect(page.locator(".thoughts-list>.thoughts-card").first()).toContainText("今天随手写");
  await page.getByRole("button", { name: /再看 40 条/ }).click();
  await expect(page.locator(".thoughts-list>.thoughts-card")).toHaveCount(80);
  await page.getByRole("group", { name: "思考来源" }).getByRole("button", { name: "博客", exact: true }).click();
  await expect(page.locator(".thoughts-list>.thoughts-card")).toHaveCount(40);
  await page.getByLabel("思考年份").selectOption("2026");
  await expect(page.locator(".thoughts-blog-card")).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.getByRole("searchbox", { name: "搜索思考" }).fill("第 85 条");
  await expect(page.locator(".thoughts-blog-card")).toHaveCount(1);
  await expect(page.locator(".thoughts-blog-card")).toContainText("旧文字 85");
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).life.thoughts, KEY);
  expect(stored).toHaveLength(1);
  expect(stored[0].createdAt).toBe("2026-10-08T00:00:00Z");
});
test("博客长原文安全展示，重读感受另存为本地思考并保留来源", async ({ page }) => {
  await open(page);
  const first = page.locator(".thoughts-blog-card").first();
  await first.getByRole("button", { name: "展开全文", exact: true }).click();
  await expect(first.locator(".thoughts-body")).toHaveText(archive.entries[0].text);
  await expect(first.locator("script")).toHaveCount(0);
  await expect(first.getByRole("button", { name: /编辑|删除/ })).toHaveCount(0);
  await first.getByRole("button", { name: "写下此刻的感受" }).click();
  await page.getByLabel("我的想法", { exact: true }).fill("今天再读，我想留一点耐心。");
  await page.getByRole("button", { name: "保存思考", exact: true }).click();
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).life.thoughts, KEY);
  expect(stored).toHaveLength(2);
  expect(stored[1].sourceExcerpt).toContain(archive.entries[0].sourceUrl);
  expect(stored[1].sourceExcerpt).toContain("测试作者");
  expect(stored[1].body).toBe("今天再读，我想留一点耐心。");
  expect(stored[1].id).not.toBe(archive.entries[0].id);
  await page.getByRole("group", { name: "思考来源" }).getByRole("button", { name: "博客", exact: true }).click();
  await expect(page.locator(".thoughts-blog-card").first().locator("time")).toHaveAttribute("datetime", archive.entries[0].date);
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

 test("随机思考跨导航保留当前记录，并能定位原思考", async ({ page }) => {
  await open(page);
  const revisit = page.getByRole("region", { name: "偶然重逢", exact: true });
  await expect(revisit).toContainText("一个属于今天的疑问。");
  await page.getByRole("searchbox", { name: "搜索思考" }).fill("不存在");
  await revisit.getByRole("button", { name: "在思考中查看", exact: true }).click();
  await expect(page.locator(`[id="thought-${LOCAL_ID}"]`)).toBeFocused();
  await expect(page.getByRole("searchbox", { name: "搜索思考" })).toHaveValue("");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^人生看板/ }).click();
  await revisit.getByRole("button", { name: "思考", exact: true }).click();
  await expect(revisit).toContainText("一个属于今天的疑问。");
  await revisit.getByRole("button", { name: "换一条", exact: true }).click();
  await expect(revisit).toContainText("测试作者");
  await revisit.getByRole("button", { name: "在思考中查看", exact: true }).click();
  await expect(page.locator('[id="thought-ashsilent:shuoshuo:1"]')).toBeFocused();
});

test("刷新合并新博客内容，网络失败时缓存和本机思考都保留", async ({ page }) => {
  await open(page);
  await expect(page.locator(".blog-sync-note")).toContainText("85 条");
  const revised = { ...archive.entries[0], text: "这句话后来补充了新的内容。" };
  const added = { ...archive.entries[1], id: "ashsilent:shuoshuo:100", sourceUrl: "https://www.ashsilent.com/shuoshuo/100", text: "刚刚发表的一条感受。", date: "2026-10-09T00:00:00Z" };
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: { ...archive, updatedAt: "2026-10-09T03:00:00Z", entries: [added, revised] } }));
  await page.reload();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^思考/ }).click();
  await expect(page.locator(".blog-sync-note")).toContainText("86 条");
  await expect(page.locator(".thoughts-list")).toContainText(added.text);
  await expect(page.locator(".thoughts-list")).toContainText(revised.text);
  await page.route("**/blog-sync.json*", route => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.reload();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^思考/ }).click();
  await expect(page.locator(".blog-sync-note")).toContainText("已缓存的内容");
  await expect(page.locator(".blog-sync-note")).toContainText("86 条");
  await expect(page.locator(".thoughts-list")).toContainText(added.text);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).life.thoughts, KEY);
  expect(stored).toHaveLength(1);
  expect(stored[0].body).toBe("一个属于今天的疑问。");
});
