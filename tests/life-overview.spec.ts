import { expect } from "@playwright/test";
import { test, writePreviewWorkspace } from "./preview-fixtures";
import { emptyLifeData } from "../lib/life";
import { parseAlipayCsv } from "../lib/finance";

test("首页汇集真实模块资料，手动线索为空仍有生活总览，手机筛选独立分组", async ({ page }) => {
  const life = emptyLifeData();
  life.reading.books = [{ id: "overview-book", title: "合成书籍", author: "测试作者", kind: "ebook", status: "reading" }];
  life.reading.highlights = [{ id: "overview-note", bookId: "overview-book", text: "原句 <script>只是文字</script>", createdAt: "2026-10-07T23:00:00+08:00" }];
  life.media.entries = [{ id: "overview-film", kind: "movie", title: "合成电影", status: "watched", genres: [], history: [{ id: "overview-watch-1", watchedAt: "2026-10-07" }, { id: "overview-watch-2", watchedAt: "2026-10-08" }] }];
  life.thoughts = [{ id: "33333333-3333-4333-8333-333333333333", title: "今天的合成想法", body: "这是一份不同领域的生活记录。", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }];
  const header = "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,";
  life.finance = (await parseAlipayCsv(`${header}\n2026-10-08 12:00:00,餐饮美食,合成商户,账户,午餐,支出,12.34,余额,交易成功,overview-order-1,商家号,,\n2026-10-09 12:00:00,交通出行,合成商户,账户,出行,支出,8.66,余额,交易成功,overview-order-2,商家号,,`)).library;
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: { version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-10-09T00:00:00Z", entries: [] } }));
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await writePreviewWorkspace(page, { version: 1, tasks: [], sources: [], batches: {}, life });
  await page.reload();
  const overview = page.getByRole("region", { name: "生活总览", exact: true });
  await expect(overview).toBeVisible();
  await overview.getByLabel("回看时间").selectOption("2026-10");
  await expect(overview.getByRole("button", { name: "查看阅读记录" })).toContainText("1");
  await expect(overview.getByRole("button", { name: "查看影音记录" })).toContainText("1");
  await expect(overview.getByRole("button", { name: "查看财务记录" })).toContainText("21.00");
  for (const source of ["阅读", "影音", "思考", "财务"]) {
    const records = overview.locator(".life-overview-record-source").filter({ hasText: source });
    expect(await records.count()).toBeGreaterThan(0);
    expect(await records.count()).toBeLessThanOrEqual(2);
  }
  await expect(overview.locator("script")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "人生看板", exact: true }).locator("small")).toHaveCount(0);
  const revisit = page.getByRole("region", { name: "偶然重逢", exact: true });
  await revisit.getByRole("group", { name: "回顾来源" }).getByRole("button", { name: "阅读", exact: true }).click();
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const gap = await page.evaluate(() => {
      const source = document.querySelector('.life-revisit [aria-label="回顾来源"]')!.getBoundingClientRect();
      const type = document.querySelector('.life-revisit [aria-label="回顾内容"]')!.getBoundingClientRect();
      return type.top - source.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(12);
  }
  await overview.getByRole("button", { name: "查看财务记录" }).click();
  await expect(page.getByRole("heading", { name: "财务", exact: true })).toBeVisible();
});
