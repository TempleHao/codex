import { z } from "zod";
import type { Area } from "./types";

export const FINANCE_AREAS = ["饮食", "衣着", "居住", "出行", "影音", "阅读", "健康", "关系", "工作", "生活", "财务", "其他"] as const satisfies readonly Area[];
export const FINANCE_NATURES = { unmarked: "未标记", fixed: "固定开销", daily: "日常消费", oneoff: "一次消费" } as const;
export const MAX_FINANCE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FINANCE_TRANSACTIONS = 20_000;
const dateSchema = z.iso.date().refine(value => !value.startsWith("0000-"));
const timestampSchema = z.iso.datetime({ offset: true }).refine(value => !value.startsWith("0000-"));
export const financeTransactionSchema = z.object({
  id: z.string().regex(/^alipay:[a-f0-9]{64}$/), refundOf: z.string().regex(/^alipay:[a-f0-9]{64}$/).optional(), occurredAt: timestampSchema,
  description: z.string().max(10000), counterparty: z.string().max(10000), category: z.string().max(1000),
  direction: z.enum(["expense", "income", "neutral"]), amountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  status: z.string().min(1).max(1000), paymentMethod: z.string().max(1000),
  area: z.enum(FINANCE_AREAS), areaSource: z.enum(["suggested", "manual"]),
  nature: z.enum(["unmarked", "fixed", "daily", "oneoff"]), note: z.string().max(10000),
}).strict();
export type FinanceTransaction = z.infer<typeof financeTransactionSchema>;
const periodSchema = z.object({ start: dateSchema, end: dateSchema }).strict().refine(value => value.start <= value.end, "起始日期不得晚于终止日期。");
export const financeLibrarySchema = z.object({
  version: z.literal(1), transactions: z.array(financeTransactionSchema).max(MAX_FINANCE_TRANSACTIONS),
  periods: z.array(periodSchema).max(100), importedAt: timestampSchema.nullable(),
}).strict().superRefine((library, context) => {
  const ids = new Set<string>();
  let amountTotal = 0n;
  for (const transaction of library.transactions) {
    if (ids.has(transaction.id)) context.addIssue({ code: "custom", message: "账单包含重复交易标识。", path: ["transactions"] });
    ids.add(transaction.id);
    amountTotal += BigInt(transaction.amountCents);
  }
  if (amountTotal > BigInt(Number.MAX_SAFE_INTEGER)) context.addIssue({ code: "custom", message: "账单合计超出安全金额范围。", path: ["transactions"] });
});
export type FinanceLibrary = z.infer<typeof financeLibrarySchema>;
export interface FinanceImport { library: FinanceLibrary; warnings: string[]; exportSummary?: { expenseCents: number; incomeCents: number; neutralCents: number } }
export function emptyFinanceLibrary(): FinanceLibrary { return { version: 1, transactions: [], periods: [], importedAt: null }; }
export function decodeAlipayCsv(bytes: ArrayBuffer): string {
  if (bytes.byteLength > MAX_FINANCE_FILE_BYTES) throw new Error("账单文件不得超过 10 MB。");
  for (const encoding of ["utf-8", "gb18030"]) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); } catch { /* Try the other supported encoding. */ }
  }
  throw new Error("账单编码无效；请使用 UTF-8 或 GB18030 CSV。");
}

interface CsvRow { fields: string[]; line: number }
function csvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [], field = "", quoted = false, closed = false, line = 1, rowLine = 1;
  const finishField = () => { fields.push(field); field = ""; closed = false; };
  const finishRow = () => { finishField(); rows.push({ fields, line: rowLine }); fields = []; rowLine = line + 1; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
      } else { field += char; if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) line++; }
    } else if (char === '"') {
      if (field || closed) throw new Error(`第 ${line} 行：CSV 引号格式无效。`);
      quoted = true;
    } else if (char === ",") finishField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      finishRow(); line++;
    } else {
      if (closed) throw new Error(`第 ${line} 行：CSV 引号后含有多余字符。`);
      field += char;
    }
  }
  if (quoted) throw new Error(`第 ${rowLine} 行：CSV 引号未闭合。`);
  if (field || fields.length || closed) { finishField(); rows.push({ fields, line: rowLine }); }
  return rows;
}
function cents(value: string, line: number): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`第 ${line} 行：金额必须是非负数，最多两位小数。`);
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`第 ${line} 行：金额超出安全范围。`);
  return Number(result);
}
function timestamp(value: string, line: number): string {
  const normalized = value.replace(" ", "T") + "+08:00";
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) || !timestampSchema.safeParse(normalized).success)
    throw new Error(`第 ${line} 行：交易时间必须是有效的年月日和时分秒。`);
  return normalized;
}
export function classifyAlipayArea(category: string): FinanceTransaction["area"] {
  const mapping: Record<string, FinanceTransaction["area"]> = {
    "餐饮美食": "饮食", "服饰装扮": "衣着", "住房物业": "居住", "交通出行": "出行", "医疗健康": "健康",
    "文化休闲": "其他", "生活日用": "生活", "家居家装": "居住", "美容美发": "生活", "运动户外": "健康", "投资理财": "财务", "信用借还": "财务",
  };
  return mapping[category] ?? "其他";
}
export type FinanceFlow = "expense" | "income" | "refund" | "neutral" | "pending" | "closed";
export type FinanceContext = ReadonlySet<string>;
/** Build from the whole library so a refund in another month still proves payment. */
export function createFinanceContext(transactions: readonly FinanceTransaction[]): FinanceContext {
  return new Set(transactions.filter(transaction => transaction.direction === "neutral" && transaction.status === "退款成功" && transaction.amountCents > 0 && transaction.refundOf).map(transaction => transaction.refundOf!));
}
export function transactionFlow(transaction: FinanceTransaction, context?: FinanceContext): FinanceFlow {
  if (transaction.status === "交易关闭" && transaction.direction === "expense" && context?.has(transaction.id)) return "expense";
  if (["交易关闭", "交易失败", "支付失败", "已关闭", "已取消"].includes(transaction.status)) return "closed";
  if (transaction.direction === "neutral" && transaction.status === "退款成功") return "refund";
  if (!["交易成功", "支付成功", "等待确认收货", "充值成功", "还款成功"].includes(transaction.status)) return "pending";
  return transaction.direction;
}
function safeAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new Error("账单合计超出安全金额范围。");
  return result;
}
export function summarizeFinance(transactions: FinanceTransaction[], context: FinanceContext = createFinanceContext(transactions)) {
  const totals = { expenseCents: 0, incomeCents: 0, refundCents: 0, neutralCents: 0, pendingCents: 0, closedCents: 0,
    expenseCount: 0, incomeCount: 0, refundCount: 0, neutralCount: 0, pendingCount: 0, closedCount: 0, netExpenseCents: 0 };
  for (const transaction of transactions) {
    const flow = transactionFlow(transaction, context);
    totals[`${flow}Cents`] = safeAdd(totals[`${flow}Cents`], transaction.amountCents);
    totals[`${flow}Count`]++;
  }
  totals.netExpenseCents = totals.expenseCents - totals.refundCents;
  return totals;
}
async function alipayId(orderId: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(orderId));
  return "alipay:" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
const HEADER = ["交易时间", "交易分类", "交易对方", "对方账号", "商品说明", "收/支", "金额", "收/付款方式", "交易状态", "交易订单号", "商家订单号", "备注"];
export async function parseAlipayCsv(text: string): Promise<FinanceImport> {
  if (new TextEncoder().encode(text).byteLength > MAX_FINANCE_FILE_BYTES * 3) throw new Error("账单内容超出文件大小限制。");
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  const headerIndex = rows.findIndex(row => HEADER.every((name, i) => row.fields[i]?.trim() === name));
  if (headerIndex < 0) throw new Error("未找到支持的支付宝交易明细表头。");
  const header = rows[headerIndex];
  if (header.fields.slice(HEADER.length).some(value => value.trim()) || header.fields.length > HEADER.length + 1) throw new Error(`第 ${header.line} 行：账单表头包含不支持的列。`);
  const metadata = rows.slice(0, headerIndex).map(row => row.fields.join(",")).join("\n");
  const periodMatch = metadata.match(/起始时间：\[([^\]]+)\]\s*终止时间：\[([^\]]+)\]/);
  if (/起始时间|终止时间/.test(metadata) && !periodMatch) throw new Error("账单导出期间格式无效。");
  const start = periodMatch ? timestamp(periodMatch[1], 1) : null;
  const end = periodMatch ? timestamp(periodMatch[2], 1) : null;
  if (start && end && start > end) throw new Error("账单导出起始时间晚于终止时间。");
  const transactions: FinanceTransaction[] = [], ids = new Map<string, FinanceTransaction>();
  const warnings: string[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.fields.every(value => !value.trim())) continue;
    if (row.fields.length !== header.fields.length) throw new Error(`第 ${row.line} 行：列数与表头不一致。`);
    if (row.fields.slice(HEADER.length).some(value => value.trim())) throw new Error(`第 ${row.line} 行：额外列必须为空。`);
    const values = row.fields.map(value => value.trim());
    const occurredAt = timestamp(values[0], row.line);
    if ((start && occurredAt < start) || (end && occurredAt > end)) throw new Error(`第 ${row.line} 行：交易时间不在导出期间内。`);
    const direction = ({ "支出": "expense", "收入": "income", "不计收支": "neutral" } as const)[values[5] as "支出" | "收入" | "不计收支"];
    if (!direction) throw new Error(`第 ${row.line} 行：不支持的收支类型。`);
    if (!values[9]) throw new Error(`第 ${row.line} 行：缺少交易订单号，无法安全去重。`);
    const id = await alipayId(values[9]);
    const refundPrefix = values[9].split(/[_*]/, 1)[0];
    const refundOf = direction === "neutral" && values[8] === "退款成功" && refundPrefix && refundPrefix !== values[9] ? await alipayId(refundPrefix) : undefined;
    const transaction = { id, ...(refundOf ? { refundOf } : {}), occurredAt, description: row.fields[4], counterparty: row.fields[2].trim(), category: values[1], direction,
      amountCents: cents(values[6], row.line), status: values[8], paymentMethod: values[7], area: classifyAlipayArea(values[1]), areaSource: "suggested" as const, nature: "unmarked" as const, note: "" };
    if (!financeTransactionSchema.safeParse(transaction).success) throw new Error(`第 ${row.line} 行：交易字段缺失或超出允许范围。`);
    const previous = ids.get(id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(transaction)) throw new Error(`第 ${row.line} 行：同一交易订单号的记录存在冲突。`);
      warnings.push(`第 ${row.line} 行：重复的相同交易已去重。`);
      continue;
    }
    ids.set(id, transaction); transactions.push(transaction);
    if (transactions.length > MAX_FINANCE_TRANSACTIONS) throw new Error("最多保存 20,000 笔交易；请缩小导出范围。");
  }
  if (!transactions.length) throw new Error("账单没有可导入的交易记录。");
  const dates = transactions.map(transaction => transaction.occurredAt.slice(0, 10)).sort();
  const library = financeLibrarySchema.parse({ version: 1, transactions, periods: [{ start: start?.slice(0, 10) ?? dates[0], end: end?.slice(0, 10) ?? dates.at(-1) }], importedAt: new Date().toISOString() });
  const summaryValues = ["支出", "收入", "不计收支"].map(label => metadata.match(new RegExp(`(?:^|\\n)${label}：\\d+笔\\s+([\\d.]+)元`)));
  const exportSummary = summaryValues.every(Boolean) ? { expenseCents: cents(summaryValues[0]![1], 1), incomeCents: cents(summaryValues[1]![1], 1), neutralCents: cents(summaryValues[2]![1], 1) } : undefined;
  if (exportSummary) {
    const raw = { expense: 0, income: 0, neutral: 0 };
    for (const transaction of transactions) raw[transaction.direction] = safeAdd(raw[transaction.direction], transaction.amountCents);
    if (raw.expense !== exportSummary.expenseCents || raw.income !== exportSummary.incomeCents || raw.neutral !== exportSummary.neutralCents)
      warnings.push("支付宝导出摘要与逐笔金额合计不同；本页按交易状态分别统计费用、退款、待处理和关闭交易，不将两种口径强行对齐。");
  }
  const pending = transactions.filter(transaction => transactionFlow(transaction) === "pending").length;
  if (pending) warnings.push(`${pending} 笔交易尚在处理中或状态未识别，暂不计入已确认收支。`);
  summarizeFinance(transactions);
  return { library, warnings, ...(exportSummary ? { exportSummary } : {}) };
}
function facts(transaction: FinanceTransaction): string {
  return JSON.stringify([transaction.id, transaction.occurredAt, transaction.description, transaction.counterparty, transaction.category, transaction.direction, transaction.amountCents, transaction.status, transaction.paymentMethod, transaction.refundOf ?? null]);
}
export function financeMergeCounts(existing: FinanceLibrary, incoming: FinanceLibrary) {
  financeLibrarySchema.parse(existing); financeLibrarySchema.parse(incoming);
  const previous = new Map(existing.transactions.map(transaction => [transaction.id, transaction]));
  const counts = { added: 0, updated: 0, unchanged: 0 };
  for (const transaction of incoming.transactions) {
    const old = previous.get(transaction.id);
    if (!old) counts.added++; else if (facts(old) === facts(transaction)) counts.unchanged++; else counts.updated++;
  }
  return counts;
}
export function mergeFinanceLibraries(existing: FinanceLibrary, incoming: FinanceLibrary): FinanceLibrary {
  financeLibrarySchema.parse(existing); financeLibrarySchema.parse(incoming);
  const transactions = new Map(existing.transactions.map(transaction => [transaction.id, transaction]));
  for (const transaction of incoming.transactions) {
    const old = transactions.get(transaction.id);
    transactions.set(transaction.id, old ? { ...transaction, ...(old.areaSource === "manual" ? { area: old.area, areaSource: "manual" as const } : {}), nature: old.nature, note: old.note } : transaction);
  }
  const periods = mergeFinancePeriods(existing.periods, incoming.periods);
  const result = financeLibrarySchema.safeParse({ version: 1, transactions: [...transactions.values()], periods, importedAt: incoming.importedAt ?? existing.importedAt });
  if (!result.success) throw new Error("合并后的账单无效或超过容量限制（20,000 笔交易、100 个期间）。");
  summarizeFinance(result.data.transactions);
  return result.data;
}
export function mergeFinancePeriods(before: FinanceLibrary["periods"], after: FinanceLibrary["periods"]): FinanceLibrary["periods"] {
  z.array(periodSchema).parse(before); z.array(periodSchema).parse(after);
  const periods: FinanceLibrary["periods"] = [];
  for (const period of [...before, ...after].sort((a, b) => a.start.localeCompare(b.start))) {
    const last = periods.at(-1);
    if (last && Date.parse(`${period.start}T00:00:00Z`) <= Date.parse(`${last.end}T00:00:00Z`) + 86_400_000) last.end = last.end > period.end ? last.end : period.end;
    else periods.push({ ...period });
  }
  if (periods.length > 100) throw new Error("最多保存 100 个账单期间。");
  return periods;
}
