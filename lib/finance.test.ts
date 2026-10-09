import { describe, expect, it } from "vitest";
import { createFinanceContext, financeTransactionSchema, classifyAlipayArea, decodeAlipayCsv, emptyFinanceLibrary, financeLibrarySchema, financeMergeCounts, mergeFinanceLibraries, mergeFinancePeriods, parseAlipayCsv, summarizeFinance, transactionFlow, type FinanceTransaction } from "./finance";
const header = "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,";
const row = (id = "synthetic-order", amount = "12.34", status = "交易成功", direction = "支出", date = "2026-07-03 12:13:14", description = "测试商品") => `${date},餐饮美食,测试商户,private-account,${description},${direction},${amount},余额,${status},${id},private-merchant-order,private-note,`;
const csv = (...rows: string[]) => ["起始时间：[2026-07-03 00:00:00]    终止时间：[2026-10-03 23:59:59]", header, ...rows].join("\r\n");
async function transaction() { return (await parseAlipayCsv(csv(row()))).library.transactions[0]; }
describe("Alipay finance import", () => {
  it("decodes BOM UTF-8 and GB18030 without replacing invalid bytes", () => {
    const bytes = new TextEncoder().encode("\uFEFF交易时间");
    expect(decodeAlipayCsv(bytes.buffer)).toBe("交易时间");
    expect(decodeAlipayCsv(Uint8Array.from([0xbd, 0xbb, 0xd2, 0xd7]).buffer)).toBe("交易");
    expect(() => decodeAlipayCsv(Uint8Array.from([0xff]).buffer)).toThrow("编码");
    expect(() => decodeAlipayCsv(new ArrayBuffer(10 * 1024 * 1024 + 1))).toThrow("10 MB");
  });
  it("parses escaped quotes, commas and embedded newlines with safe description preservation", async () => {
    const result = await parseAlipayCsv(csv(row("synthetic-order", "12.34", "交易成功", "支出", "2026-07-03 12:13:14", '"第一行,\n""第二行"""')));
    expect(result.library.transactions[0]).toMatchObject({ description: '第一行,\n"第二行"', amountCents: 1234, occurredAt: "2026-07-03T12:13:14+08:00", area: "饮食" });
    expect(JSON.stringify(result)).not.toContain("private-account");
    expect(JSON.stringify(result)).not.toContain("private-merchant-order");
    expect(JSON.stringify(result)).not.toContain("synthetic-order");
    expect(JSON.stringify(result)).not.toContain("private-note");
    await expect(parseAlipayCsv(csv(row().replace("测试商品", '坏"引号')))).rejects.toThrow("第 3 行");
    await expect(parseAlipayCsv(csv(row().replace("测试商品", '"未闭合')))).rejects.toThrow("未闭合");
  });
  it("rejects every malformed row atomically and uses physical line numbers", async () => {
    for (const amount of ["-1", "1.001", "NaN", "1e3", "90071992547409.92"]) await expect(parseAlipayCsv(csv(row("first"), row("bad", amount)))).rejects.toThrow("第 4 行");
    for (const date of ["2026-02-30 00:00:00", "2026-07-03 24:00:00", "0000-07-03 00:00:00", "2026-10-04 00:00:00"]) await expect(parseAlipayCsv(csv(row("bad", "1", "交易成功", "支出", date)))).rejects.toThrow("第 3 行");
    await expect(parseAlipayCsv(csv(row("")))).rejects.toThrow("订单号");
    await expect(parseAlipayCsv(csv(row("bad", "1", "交易成功", "未知")))).rejects.toThrow("收支类型");
    await expect(parseAlipayCsv(csv(row("first", "1", "交易成功", "支出", "2026-07-03 12:13:14", '"a\nb"'), row("bad", "bad")))).rejects.toThrow("第 5 行");
  });
  it("keeps refund suffixes distinct and refuses duplicate source conflicts", async () => {
    const result = await parseAlipayCsv(csv(row("same"), row("same"), row("same-refund", "2", "退款成功", "不计收支")));
    expect(result.library.transactions).toHaveLength(2);
    expect(result.warnings.join()).toContain("去重");
    await expect(parseAlipayCsv(csv(row("same", "1"), row("same", "2")))).rejects.toThrow("冲突");
  });
  it("counts closed payments only when exact anonymous successful positive refunds prove payment", async () => {
    const result = await parseAlipayCsv(csv(row("paid-closed", "100", "交易关闭"), row("paid-closed_refund1", "100", "退款成功", "不计收支"), row("unpaid-closed", "9", "交易关闭"), row("zero-closed", "7", "交易关闭"), row("zero-closed_refund1", "0", "退款成功", "不计收支"), row("other-period_refund1", "5", "退款成功", "不计收支")));
    const transactions = result.library.transactions;
    expect(transactions[1].refundOf).toBe(transactions[0].id);
    expect(transactions[1].id).not.toBe(transactions[1].refundOf);
    const context = createFinanceContext(transactions);
    expect(transactionFlow(transactions[0], context)).toBe("expense");
    expect(transactionFlow(transactions[2], context)).toBe("closed");
    expect(transactionFlow(transactions[3], context)).toBe("closed");
    expect(summarizeFinance(transactions)).toMatchObject({ expenseCents: 10000, expenseCount: 1, refundCents: 10500, refundCount: 3, closedCents: 1600, closedCount: 2, netExpenseCents: -500 });
    expect(JSON.stringify(result)).not.toContain("paid-closed");
  });
  it("handles multiple partial refunds and uses whole-library proof for month slices", async () => {
    const result = await parseAlipayCsv(csv(row("original", "100", "交易关闭", "支出", "2026-07-03 12:00:00"), row("original_first", "30", "退款成功", "不计收支", "2026-08-03 12:00:00"), row("original_second*extra", "20", "退款成功", "不计收支", "2026-08-04 12:00:00")));
    const transactions = result.library.transactions;
    const context = createFinanceContext(transactions);
    expect(transactions[1].refundOf).toBe(transactions[0].id);
    expect(transactions[2].refundOf).toBe(transactions[0].id);
    expect(summarizeFinance(transactions, context)).toMatchObject({ expenseCents: 10000, refundCents: 5000, netExpenseCents: 5000 });
    expect(summarizeFinance([transactions[0]], context)).toMatchObject({ expenseCents: 10000, refundCents: 0, netExpenseCents: 10000 });
    expect(summarizeFinance(transactions.slice(1), context)).toMatchObject({ expenseCents: 0, refundCents: 5000, netExpenseCents: -5000 });
    const pendingRefund = { ...transactions[1], status: "退款处理中" };
    expect(transactionFlow(transactions[0], createFinanceContext([transactions[0], pendingRefund]))).toBe("closed");
    const matchingAmountOnly = { ...transactions[1], refundOf: undefined, amountCents: transactions[0].amountCents };
    expect(transactionFlow(transactions[0], createFinanceContext([transactions[0], matchingAmountOnly]))).toBe("closed");
  });
  it("accepts old records without refund linkage and enriches them on reimport", async () => {
    const incoming = (await parseAlipayCsv(csv(row("original", "10", "交易关闭"), row("original_refund", "10", "退款成功", "不计收支")))).library;
    const legacy = { ...incoming, transactions: incoming.transactions.map(({ refundOf: _refundOf, ...transaction }) => transaction) };
    expect(financeLibrarySchema.safeParse(legacy).success).toBe(true);
    expect(financeTransactionSchema.safeParse({ ...legacy.transactions[1], refundOf: "raw-order-number" }).success).toBe(false);
    expect(summarizeFinance(legacy.transactions)).toMatchObject({ expenseCents: 0, refundCents: 1000, closedCents: 1000 });
    expect(financeMergeCounts(legacy, incoming)).toEqual({ added: 0, updated: 1, unchanged: 1 });
    expect(summarizeFinance(mergeFinanceLibraries(legacy, incoming).transactions)).toMatchObject({ expenseCents: 1000, refundCents: 1000, netExpenseCents: 0 });
  });
  it("counts only explicit confirmed flows and never treats repayments as spending", async () => {
    const result = await parseAlipayCsv(csv(row("paid", "10"), row("await", "2", "等待确认收货"), row("refund", "3", "退款成功", "不计收支"), row("repay", "100", "还款成功", "不计收支"), row("transfer", "5", "交易成功", "不计收支"), row("income", "7", "交易成功", "收入"), row("pending", "1", "缴费中"), row("unknown", "2", "未来状态"), row("closed", "4", "交易关闭")));
    expect(summarizeFinance(result.library.transactions)).toEqual({ expenseCents: 1200, expenseCount: 2, incomeCents: 700, incomeCount: 1, refundCents: 300, refundCount: 1, neutralCents: 10500, neutralCount: 2, pendingCents: 300, pendingCount: 2, closedCents: 400, closedCount: 1, netExpenseCents: 900 });
    expect(transactionFlow({ ...result.library.transactions[0], status: "退款成功", direction: "expense" })).toBe("pending");
    expect(classifyAlipayArea("亲友代付")).toBe("其他");
    expect(classifyAlipayArea("转账红包")).toBe("其他");
  });
  it("reports export summary discrepancies without reconciling paid totals", async () => {
    const result = await parseAlipayCsv(["收入：0笔 0.00元", "支出：1笔 99.00元", "不计收支：0笔 0.00元", csv(row())].join("\n"));
    expect(result.exportSummary?.expenseCents).toBe(9900);
    expect(result.warnings.join()).toContain("不同");
    expect(summarizeFinance(result.library.transactions).expenseCents).toBe(1234);
  });
  it("infers coverage from valid data when the export lacks a preamble", async () => {
    expect((await parseAlipayCsv([header, row()].join("\n"))).library.periods).toEqual([{ start: "2026-07-03", end: "2026-07-03" }]);
    await expect(parseAlipayCsv(`起始时间：坏日期\n${header}\n${row()}`)).rejects.toThrow("期间格式");
  });
});
describe("Finance library merge", () => {
  it("updates source facts and preserves manual annotations, then becomes idempotent", async () => {
    const imported = (await parseAlipayCsv(csv(row("same", "10", "缴费中")))).library;
    const old = { ...imported, transactions: [{ ...imported.transactions[0], area: "工作" as const, areaSource: "manual" as const, nature: "fixed" as const, note: "local note" }] };
    const incoming = (await parseAlipayCsv(csv(row("same", "10", "交易成功"), row("new", "1")))).library;
    expect(financeMergeCounts(old, incoming)).toEqual({ added: 1, updated: 1, unchanged: 0 });
    const merged = mergeFinanceLibraries(old, incoming);
    expect(merged.transactions[0]).toMatchObject({ status: "交易成功", area: "工作", areaSource: "manual", nature: "fixed", note: "local note" });
    expect(financeMergeCounts(merged, incoming)).toEqual({ added: 0, updated: 0, unchanged: 2 });
    expect(mergeFinanceLibraries(merged, incoming)).toEqual(merged);
    const reordered = { ...incoming, transactions: incoming.transactions.map(value => Object.fromEntries(Object.entries(value).reverse()) as FinanceTransaction) };
    expect(financeMergeCounts(merged, reordered)).toEqual({ added: 0, updated: 0, unchanged: 2 });
    expect(financeLibrarySchema.safeParse({ ...merged, transactions: [...merged.transactions, merged.transactions[0]] }).success).toBe(false);
  });
  it("merges overlapping and adjacent periods without mutating input", () => {
    const periods = [{ start: "2026-01-01", end: "2026-01-03" }];
    expect(mergeFinancePeriods(periods, [{ start: "2026-01-03", end: "2026-01-04" }, { start: "2026-01-05", end: "2026-01-10" }])).toEqual([{ start: "2026-01-01", end: "2026-01-10" }]);
    expect(periods[0].end).toBe("2026-01-03");
  });
  it("rejects transaction and coverage capacity overflow atomically", async () => {
    const base = await transaction();
    const many: FinanceTransaction[] = Array.from({ length: 20000 }, (_, i) => ({ ...base, id: `alipay:${i.toString(16).padStart(64, "0")}` }));
    const existing = { ...emptyFinanceLibrary(), transactions: many };
    expect(() => mergeFinanceLibraries(existing, { ...emptyFinanceLibrary(), transactions: [base] })).toThrow("容量");
    const periods = Array.from({ length: 101 }, (_, i) => ({ start: `${2000 + i}-01-01`, end: `${2000 + i}-01-01` }));
    expect(() => mergeFinancePeriods(periods.slice(0, 100), periods.slice(100))).toThrow("100");
    expect(financeLibrarySchema.safeParse({ ...emptyFinanceLibrary(), transactions: [{ ...base, amountCents: Number.MAX_SAFE_INTEGER }, { ...base, id: `alipay:${"0".repeat(64)}`, amountCents: 1 }] }).success).toBe(false);
  });
});
