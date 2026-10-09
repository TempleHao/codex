import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { test, readPreviewWorkspace, watchPreviewUnlock } from "./preview-fixtures";

const KEY = "life-workbench-preview-v1";
const HEADER = "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,";
const SYNTHETIC_DESCRIPTION = "仅供测试的账单商品";
function syntheticCsv() {
  const row = (index: number, amount: string, status: string, direction: string) => `2026-${index < 9 ? "07" : "08"}-${String(index % 9 + 1).padStart(2, "0")} 12:00:00,生活日用,合成测试商户,synthetic-account,${SYNTHETIC_DESCRIPTION}${index},${direction},${amount},余额,${status},synthetic-finance-order-${index},synthetic-merchant-order,,`;
  return ["起始时间：[2026-07-01 00:00:00]    终止时间：[2026-08-31 23:59:59]", HEADER,
    ...Array.from({ length: 18 }, (_, index) => row(index, "10.10", "交易成功", "支出")),
    row(18, "2.50", "退款成功", "不计收支"), row(19, "200.00", "还款成功", "不计收支"),
    row(20, "88.00", "交易关闭", "支出"), row(21, "3.00", "缴费中", "支出"), row(22, "5.50", "交易成功", "收入"),
  ].join("\r\n");
}
async function openFinance(page: Page) {
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^财务/ }).click();
  await expect(page.getByRole("heading", { name: "财务", exact: true })).toBeVisible();
}
async function preview(page: Page, text = syntheticCsv()) {
  await page.getByLabel("支付宝账单 CSV", { exact: true }).setInputFiles({ name: "synthetic-alipay.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
}
async function importFinance(page: Page) {
  await preview(page);
  await expect(page.locator(".finance-import")).toContainText("读取 23 笔记录");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".finance-import")).toHaveCount(0);
  await expect.poll(async () => (await readPreviewWorkspace(page))?.life.finance.transactions.length).toBe(23);
}

test("财务导入先预览，确认后按真实收支分类展示与分页，原文不上传", async ({ page }) => {
  const uploads: string[] = [];
  page.on("request", request => {
    const outgoing = `${request.url()}\n${request.postData() ?? ""}`;
    if (outgoing.includes(SYNTHETIC_DESCRIPTION) || outgoing.includes(encodeURIComponent(SYNTHETIC_DESCRIPTION)) || outgoing.includes("synthetic-finance-order")) uploads.push(request.url());
  });
  await openFinance(page);
  const ciphertext = await page.evaluate(key => localStorage.getItem(key), KEY);
  await preview(page);
  const panel = page.locator(".finance-import");
  await expect(panel).toContainText("读取 23 笔记录");
  await expect(panel).toContainText("¥181.80");
  await expect(panel).toContainText("¥2.50");
  await expect(panel).toContainText("¥5.50");
  await expect(panel).toContainText("¥200.00");
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(ciphertext);
  expect((await readPreviewWorkspace(page))!.life.finance.transactions).toEqual([]);
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".finance-expense-total")).toContainText("¥181.80");
  await expect(page.locator(".finance-flow-context")).toContainText("不计收支 1 笔 · ¥200.00");
  await expect(page.locator(".finance-transaction")).toHaveCount(15);
  await expect(page.getByRole("navigation", { name: "账单分页" })).toContainText("1–15 / 23 笔");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".finance-transaction")).toHaveCount(8);
  await expect(page.getByRole("navigation", { name: "账单分页" })).toContainText("16–23 / 23 笔");
  await page.getByRole("combobox", { name: "回看时间", exact: true }).selectOption("2026-07");
  await expect(page.locator(".finance-expense-total")).toContainText("¥90.90");
  const raw = await page.evaluate(key => localStorage.getItem(key), KEY);
  expect(raw).not.toContain(SYNTHETIC_DESCRIPTION);
  expect(raw).not.toContain("synthetic-account");
  expect(uploads).toEqual([]);
});

test("手动花费标记在重复导入后保留，消费回顾写入人生看板", async ({ page }) => {
  await openFinance(page);
  await importFinance(page);
  await page.getByLabel("搜索账单", { exact: true }).fill(`${SYNTHETIC_DESCRIPTION}0`);
  const card = page.locator(".finance-transaction");
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "标记这笔花费", exact: true }).click();
  await card.getByRole("combobox", { name: "生活领域", exact: true }).selectOption("工作");
  await card.getByRole("combobox", { name: "消费性质", exact: true }).selectOption("fixed");
  await card.getByLabel("备注（可选）", { exact: true }).fill("合成测试人工备注");
  await card.getByRole("button", { name: "保存标记", exact: true }).click();
  await expect(card).toContainText("合成测试人工备注");
  await preview(page);
  await expect(page.locator(".finance-preview-counts")).toContainText("未变 23 笔");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".finance-import")).toHaveCount(0);
  const transaction = (await readPreviewWorkspace(page))!.life.finance.transactions.find(value => value.description === `${SYNTHETIC_DESCRIPTION}0`);
  expect(transaction).toMatchObject({ area: "工作", areaSource: "manual", nature: "fixed", note: "合成测试人工备注" });
  await page.getByRole("button", { name: "写下回顾", exact: true }).click();
  await page.getByLabel("我的回顾", { exact: true }).fill("这次合成测试记录让我看见生活的花费。");
  await page.getByLabel("记录日期", { exact: true }).fill("2026-08-31");
  await page.getByRole("button", { name: "记在人生看板", exact: true }).click();
  await expect.poll(async () => (await readPreviewWorkspace(page))?.life.board.observations.some(value => value.area === "财务" && value.text === "这次合成测试记录让我看见生活的花费。" && value.date === "2026-08-31")).toBe(true);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^人生看板/ }).click();
  await expect(page.locator(".life-board")).toContainText("这次合成测试记录让我看见生活的花费。");
});

test("格式错误与存储额度失败不部分保存，失败预览可以重试", async ({ page }) => {
  await openFinance(page);
  const before = await page.evaluate(key => localStorage.getItem(key), KEY);
  await preview(page, syntheticCsv().replace(",10.10,", ",-10.10,"));
  await expect(page.locator(".finance-panel").getByRole("alert")).toContainText("金额必须是非负数");
  await expect(page.locator(".finance-import")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(before);
  await preview(page);
  await expect(page.locator(".finance-import")).toBeVisible();
  await page.evaluate(key => {
    const nativeSet = Storage.prototype.setItem;
    const testWindow = window as unknown as { financeQuotaFailure: boolean };
    testWindow.financeQuotaFailure = true;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && testWindow.financeQuotaFailure) throw new DOMException("Synthetic quota", "QuotaExceededError");
      nativeSet.call(this, name, value);
    };
  }, KEY);
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".finance-panel").getByRole("alert")).toContainText("导入未保存，预览已保留");
  await expect(page.locator(".finance-import")).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(before);
  expect((await readPreviewWorkspace(page))!.life.finance.transactions).toEqual([]);
  await page.evaluate(() => { (window as unknown as { financeQuotaFailure: boolean }).financeQuotaFailure = false; });
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".finance-import")).toHaveCount(0);
  await expect.poll(async () => (await readPreviewWorkspace(page))?.life.finance.transactions.length).toBe(23);
});

test("财务完整备份可恢复到独立加密空间", async ({ page, browser }) => {
  await openFinance(page);
  await importFinance(page);
  const original = (await readPreviewWorkspace(page))!.life.finance;
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const file = await (await downloading).path();
  expect(file).not.toBeNull();
  const exported = JSON.parse(await readFile(file!, "utf8"));
  expect(exported.life.finance).toEqual(original);
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    watchPreviewUnlock(second);
    await second.goto(page.url());
    await expect(second.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
    await second.getByLabel("选择完整备份文件", { exact: true }).setInputFiles(file!);
    await expect.poll(async () => (await readPreviewWorkspace(second))?.life.finance).toEqual(original);
    const raw = await second.evaluate(key => localStorage.getItem(key), KEY);
    expect(raw).not.toContain(SYNTHETIC_DESCRIPTION);
    await second.reload();
    await expect(second.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
    expect((await readPreviewWorkspace(second))!.life.finance).toEqual(original);
  } finally { await other.close(); }
});

test("跨月退款关联关闭原支付，月份与支出筛选不会重复扣退款", async ({ page }) => {
  await openFinance(page);
  const csv = [HEADER,
    "2026-07-20 12:00:00,生活日用,合成商户,测试账户,已全额退款的原支付,支出,12.00,余额,交易关闭,refundlink-original,测试商家号,,",
    "2026-08-01 12:00:00,退款,合成商户,测试账户,原支付的退款,不计收支,12.00,余额,退款成功,refundlink-original_1,测试商家号,,",
    "2026-07-21 12:00:00,生活日用,合成商户,测试账户,未付款的关闭订单,支出,30.00,余额,交易关闭,refundlink-unpaid,测试商家号,,",
  ].join("\n");
  await preview(page, csv);
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.locator(".finance-expense-total")).toContainText("¥12.00");
  await expect(page.locator(".finance-stat").filter({ hasText: "支出减退款" })).toContainText("¥0.00");
  await page.getByRole("combobox", { name: "回看时间", exact: true }).selectOption("2026-07");
  await expect(page.locator(".finance-expense-total")).toContainText("¥12.00");
  await expect(page.locator(".finance-stat").filter({ hasText: "收到退款" })).toContainText("¥0.00");
  await page.getByRole("combobox", { name: "收支类型", exact: true }).selectOption("expense");
  await expect(page.locator(".finance-transaction")).toHaveCount(1);
  await expect(page.locator(".finance-transaction")).toContainText("已全额退款的原支付");
  await page.getByRole("combobox", { name: "回看时间", exact: true }).selectOption("2026-08");
  await expect(page.locator(".finance-expense-total")).toContainText("¥0.00");
  await expect(page.locator(".finance-stat").filter({ hasText: "支出减退款" })).toContainText("-¥12.00");
  await page.reload();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^财务/ }).click();
  await expect(page.locator(".finance-expense-total")).toContainText("¥12.00");
  expect((await readPreviewWorkspace(page))?.life.finance.transactions.find(row => row.direction === "neutral")?.refundOf).toMatch(/^alipay:[a-f0-9]{64}$/);
});
