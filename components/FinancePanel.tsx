"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { chinaToday } from "@/lib/dates";
import {
  FINANCE_AREAS, FINANCE_NATURES, decodeAlipayCsv, parseAlipayCsv,
  financeMergeCounts, mergeFinanceLibraries, summarizeFinance, transactionFlow, createFinanceContext,
  type FinanceImport, type FinanceLibrary, type FinanceTransaction,
} from "@/lib/finance";
import "./finance.css";

export interface FinancePanelProps {
  library: FinanceLibrary;
  onChange: (next: FinanceLibrary) => Promise<void>;
  onRemember: (text: string, date: string) => Promise<void>;
}
const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const money = (cents: number) => currency.format(cents / 100);
const flowLabels = { expense: "支出", refund: "退款", income: "收入", neutral: "不计收支", pending: "处理中", closed: "已关闭" };
const PAGE_SIZE = 15;
const errorText = (error: unknown) => error instanceof Error ? error.message : "请稍后重试。";
const monthLabel = (month: string) => `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;

function coverageFor(library: FinanceLibrary, month: string): string {
  if (!library.periods.length) return "账单未提供记录范围";
  const ranges = library.periods.map(({ start, end }) => ({ start: start.slice(0, 10), end: end.slice(0, 10) })).sort((a, b) => a.start.localeCompare(b.start));
  if (!month) return ranges.map(({ start, end }) => `${start} 至 ${end}`).join("；");
  const first = `${month}-01`;
  const last = `${month}-${new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()}`;
  const relevant = ranges.filter((range) => range.end >= first && range.start <= last);
  if (!relevant.length) return "本月记录范围未提供，可能不完整";
  let cursor = first;
  for (const range of relevant) {
    if (range.start > cursor) return "本月账单覆盖部分日期";
    if (range.end >= last) return "账单覆盖本月全部日期";
    const next = new Date(`${range.end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return "本月账单覆盖部分日期";
}

function TransactionCard({ row, onSave, saving, context }: {
  context: ReadonlySet<string>;
  row: FinanceTransaction;
  onSave: (id: string, patch: Pick<FinanceTransaction, "area" | "nature" | "note">) => Promise<void>;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [area, setArea] = useState<FinanceTransaction["area"]>(row.area);
  const [nature, setNature] = useState(row.nature);
  const [note, setNote] = useState(row.note);
  const [error, setError] = useState("");
  const formId = useId();
  const flow = transactionFlow(row, context);
  function edit() {
    setArea(row.area); setNature(row.nature); setNote(row.note); setError(""); setEditing(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    try { await onSave(row.id, { area, nature, note: note.trim() }); setEditing(false); }
    catch (error) { setError(`标记未保存。${errorText(error)}`); }
  }
  return <article className="finance-transaction">
    <div className="finance-transaction-main">
      <div><p className="finance-eyebrow"><time dateTime={row.occurredAt}>{row.occurredAt.slice(0, 10)} · {row.occurredAt.slice(11, 16)}</time><span>{flowLabels[flow]}</span></p>
        <h3>{row.description || row.counterparty || "账单记录"}</h3>
        <p className="finance-transaction-meta">{row.counterparty && <span>{row.counterparty}</span>}<span>{row.area}</span><span>{row.category || "未分类"}</span>{row.nature !== "unmarked" && <span>{FINANCE_NATURES[row.nature]}</span>}</p>
      </div><strong className={`finance-amount finance-amount-${flow}`}>{flow === "refund" || flow === "income" ? "+" : flow === "expense" ? "−" : ""}{money(row.amountCents)}</strong>
    </div>
    {row.note && <p className="finance-row-note">{row.note}</p>}
    <div className="finance-row-actions"><details><summary>账单详情</summary><dl className="finance-details">
      <div><dt>商品说明</dt><dd>{row.description || "—"}</dd></div><div><dt>交易对方</dt><dd>{row.counterparty || "—"}</dd></div>
      <div><dt>原分类</dt><dd>{row.category || "—"}</dd></div><div><dt>付款方式</dt><dd>{row.paymentMethod || "—"}</dd></div>
      <div><dt>状态</dt><dd>{row.status || "—"}</dd></div><div><dt>生活领域</dt><dd>{row.area} · {row.areaSource === "manual" ? "自己标记" : "账单建议"}</dd></div>
    </dl></details><button type="button" onClick={edit} disabled={saving || editing}>标记这笔花费</button></div>
    {editing && <form className="finance-annotation" onSubmit={save}>
      <div className="finance-form-grid"><label htmlFor={`${formId}-area`}>生活领域<select id={`${formId}-area`} value={area} onChange={(event) => setArea(event.target.value as FinanceTransaction["area"])}>{FINANCE_AREAS.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label htmlFor={`${formId}-nature`}>消费性质<select id={`${formId}-nature`} value={nature} onChange={(event) => setNature(event.target.value as FinanceTransaction["nature"])}>{Object.entries(FINANCE_NATURES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label htmlFor={`${formId}-note`}>备注（可选）<textarea id={`${formId}-note`} value={note} maxLength={5000} rows={3} onChange={(event) => setNote(event.target.value)} /></label>
      {error && <p className="finance-error" role="alert">{error}</p>}
      <div className="finance-actions"><button className="finance-primary" disabled={saving} type="submit">{saving ? "保存中…" : "保存标记"}</button><button disabled={saving} type="button" onClick={() => setEditing(false)}>取消</button></div>
    </form>}
  </article>;
}

export default function FinancePanel({ library, onChange, onRemember }: FinancePanelProps) {
  const [month, setMonth] = useState("");
  const [search, setSearch] = useState("");
  const [area, setArea] = useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [groupBy, setGroupBy] = useState<"area" | "category">("area");
  const [preview, setPreview] = useState<{ name: string; parsed: FinanceImport } | null>(null);
  const [importError, setImportError] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState("");
  const [reviewDate, setReviewDate] = useState(chinaToday);
  const [reviewError, setReviewError] = useState("");
  const busy = useRef(false);
  const readBusy = useRef(false);
  const latestLibrary = useRef(library);
  latestLibrary.current = library;
  const fileInput = useRef<HTMLInputElement>(null);
  const ledger = useRef<HTMLElement>(null);
  const focusLedger = useRef(false);
  const id = useId();
  const months = useMemo(() => Array.from(new Set(library.transactions.map((row) => row.occurredAt.slice(0, 7)))).sort().reverse(), [library.transactions]);
  const monthRows = useMemo(() => library.transactions.filter((row) => !month || row.occurredAt.startsWith(month)), [library.transactions, month]);
  const context = useMemo(() => createFinanceContext(library.transactions), [library.transactions]);
  const summary = useMemo(() => summarizeFinance(monthRows, context), [monthRows, context]);
  const groups = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of monthRows) if (transactionFlow(row, context) === "expense") {
      const key = groupBy === "area" ? row.area : row.category || "未分类";
      totals.set(key, (totals.get(key) || 0) + row.amountCents);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [monthRows, groupBy, context]);
  const trends = useMemo(() => [...months].reverse().map((value) => ({ month: value, cents: summarizeFinance(library.transactions.filter((row) => row.occurredAt.startsWith(value)), context).expenseCents })), [months, library.transactions, context]);
  const maxTrend = Math.max(...trends.map((item) => item.cents), 1);
  const fixedCents = monthRows.filter((row) => row.areaSource === "manual" && row.nature === "fixed" && transactionFlow(row, context) === "expense").reduce((sum, row) => sum + row.amountCents, 0);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return monthRows.filter((row) => {
      const flow = transactionFlow(row, context);
      return (!area || row.area === area) && (!kind || (kind === "other" ? ["neutral", "pending", "closed"].includes(flow) : flow === kind))
        && (!query || [row.description, row.counterparty, row.note].some((value) => value.toLocaleLowerCase().includes(query)));
    }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
  }, [monthRows, area, kind, search, context]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  useEffect(() => {
    if (!focusLedger.current) return;
    focusLedger.current = false;
    ledger.current?.focus({ preventScroll: true });
    ledger.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [currentPage]);
  function changePage(value: number) {
    const next = Math.max(1, Math.min(value, pages));
    if (next === currentPage) return;
    focusLedger.current = true; setPage(next);
  }
  const mergeCounts = preview ? financeMergeCounts(library, preview.parsed.library) : null;
  const previewContext = useMemo(() => {
    if (!preview) return undefined;
    const latest = new Map([...library.transactions, ...preview.parsed.library.transactions].map(row => [row.id, row]));
    return createFinanceContext([...latest.values()]);
  }, [library.transactions, preview]);
  const previewTotals = preview ? summarizeFinance(preview.parsed.library.transactions, previewContext) : null;
  function selectMonth(value: string) { setMonth(value); setPage(1); }
  async function readFile(file?: File) {
    if (!file || readBusy.current || busy.current) return;
    setImportError(""); setNotice(""); setPreview(null);
    if (!/\.csv$/i.test(file.name)) { setImportError("请选择支付宝账单 CSV 文件。"); return; }
    if (file.size > 10 * 1024 * 1024) { setImportError("文件不能超过 10 MB，请分段导出账单。"); return; }
    readBusy.current = true; setReading(true);
    try { const parsed = await parseAlipayCsv(decodeAlipayCsv(await file.arrayBuffer())); setPreview({ name: file.name, parsed }); }
    catch (error) { setImportError(`账单未读取。${errorText(error)}`); }
    finally { readBusy.current = false; setReading(false); }
  }
  async function persist(next: FinanceLibrary) {
    if (busy.current) throw new Error("另一项保存仍在进行，请稍后重试。");
    busy.current = true; setSaving(true);
    try { await onChange(next); }
    finally { busy.current = false; setSaving(false); }
  }
  async function confirmImport() {
    if (!preview || busy.current) return;
    setImportError("");
    try {
      const counts = financeMergeCounts(latestLibrary.current, preview.parsed.library);
      await persist(mergeFinanceLibraries(latestLibrary.current, preview.parsed.library));
      setNotice(`账单已导入：新增 ${counts.added} 笔，更新 ${counts.updated} 笔，未变 ${counts.unchanged} 笔。`);
      setPage(1);
      setPreview(null); if (fileInput.current) fileInput.current.value = "";
    } catch (error) { setImportError(`导入未保存，预览已保留。${errorText(error)}`); }
  }
  async function saveAnnotation(transactionId: string, patch: Pick<FinanceTransaction, "area" | "nature" | "note">) {
    const current = latestLibrary.current;
    if (!current.transactions.some((row) => row.id === transactionId)) throw new Error("这笔记录已不存在。");
    await persist({ ...current, transactions: current.transactions.map((row) => row.id === transactionId ? { ...row, ...patch, areaSource: "manual" } : row) });
  }
  async function saveReview(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !review.trim() || !reviewDate) return;
    busy.current = true; setSaving(true); setReviewError("");
    try { await onRemember(review.trim(), reviewDate); setReview(""); setReviewOpen(false); setNotice("这段消费感受已记在人生看板的财务发现里。"); }
    catch (error) { setReviewError(`感受未保存，文字已保留。${errorText(error)}`); }
    finally { busy.current = false; setSaving(false); }
  }
  return <section className="finance-panel" aria-labelledby={`${id}-title`}>
    <header className="finance-heading"><div><p className="finance-eyebrow">生活的另一面</p><h1 id={`${id}-title`}>财务</h1><p>钱花在哪里，也是一种生活的记录。</p></div>
      <div className="finance-actions"><button type="button" onClick={() => setReviewOpen(true)}>写下回顾</button><button type="button" className="finance-primary" disabled={reading || saving} onClick={() => fileInput.current?.click()}>{reading ? "读取账单中…" : "导入支付宝账单"}</button></div>
    </header>
    <input ref={fileInput} className="finance-file" type="file" aria-label="支付宝账单 CSV" accept=".csv" disabled={reading || saving} onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ""; }} />
    {notice && <p className="finance-notice" role="status">{notice}</p>}
    {importError && <p className="finance-error" role="alert">{importError}</p>}
    {preview && <section className="finance-import finance-card" aria-labelledby={`${id}-preview`}>
      <p className="finance-eyebrow">导入预览</p><h2 id={`${id}-preview`}>{preview.name}</h2><p>读取 {preview.parsed.library.transactions.length} 笔记录。确认后才会保存。</p>
      <div className="finance-preview-counts"><span>新增 <strong>{mergeCounts?.added}</strong> 笔</span><span>更新 <strong>{mergeCounts?.updated}</strong> 笔</span><span>未变 <strong>{mergeCounts?.unchanged}</strong> 笔</span></div>
      {previewTotals && <dl className="finance-preview-totals"><div><dt>已支付支出</dt><dd>{money(previewTotals.expenseCents)}</dd></div><div><dt>收到退款</dt><dd>{money(previewTotals.refundCents)}</dd></div><div><dt>收入</dt><dd>{money(previewTotals.incomeCents)}</dd></div><div><dt>不计收支</dt><dd>{money(previewTotals.neutralCents)}</dd></div></dl>}
      <p className="finance-caption">记录范围：{coverageFor(preview.parsed.library, "")}</p>
      {preview.parsed.exportSummary && <p className="finance-caption">支付宝文件摘要：支出 {money(preview.parsed.exportSummary.expenseCents)}、收入 {money(preview.parsed.exportSummary.incomeCents)}。上方按交易状态及关联退款统计，处理中金额单列。</p>}
      {preview.parsed.warnings.length > 0 && <ul className="finance-import-warnings">{preview.parsed.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div className="finance-actions"><button className="finance-primary" type="button" disabled={saving} onClick={() => void confirmImport()}>{saving ? "保存中…" : "确认导入"}</button><button type="button" disabled={saving} onClick={() => { setPreview(null); setImportError(""); }}>取消</button></div>
    </section>}
    {reviewOpen && <form className="finance-review finance-card" onSubmit={saveReview}><h2>写下消费感受</h2><p className="finance-caption">有什么花费让你记住了这段生活？这段文字会留在人生看板的财务发现里。</p>
      <label htmlFor={`${id}-review`}>我的回顾<textarea autoFocus id={`${id}-review`} value={review} onChange={(event) => setReview(event.target.value)} maxLength={5000} rows={4} placeholder="也许是一顿饭、一段旅程，或最近才注意到的生活习惯。" required /></label>
      <label className="finance-date" htmlFor={`${id}-review-date`}>记录日期<input id={`${id}-review-date`} type="date" value={reviewDate} onChange={(event) => setReviewDate(event.target.value)} required /></label>
      {reviewError && <p className="finance-error" role="alert">{reviewError}</p>}<div className="finance-actions"><button className="finance-primary" disabled={saving || !review.trim()} type="submit">{saving ? "保存中…" : "记在人生看板"}</button><button type="button" disabled={saving} onClick={() => setReviewOpen(false)}>收起</button></div>
    </form>}
    {!library.transactions.length ? <div className="finance-empty finance-card"><div className="finance-empty-art" aria-hidden="true">¥<span>生活账簿</span></div><h2>从一份账单开始，回看生活的花费</h2><p>在支付宝导出账单 CSV，再导入这里。花费可以按月份与生活领域慢慢整理。</p><p className="finance-caption">账单只在本机读取与保存。换设备前，可从页脚导出备份。</p></div> : <>
      <div className="finance-period"><label htmlFor={`${id}-month`}>回看时间<select id={`${id}-month`} value={month} onChange={(event) => selectMonth(event.target.value)}><option value="">全部月份</option>{months.map((value) => <option value={value} key={value}>{monthLabel(value)}</option>)}</select></label><div><p>{coverageFor(library, month)}</p><p className="finance-caption">这份账单的记录范围，仅代表已导入记录，不是全账户资产或预算。</p></div></div>
      <section className="finance-overview" aria-label="收支概览"><div className="finance-expense-total"><p>{month ? monthLabel(month) : "已导入账单"} · 已支付支出</p><strong>{money(summary.expenseCents)}</strong><span>{summary.expenseCount} 笔支出，记录日常生活的去向</span></div>
        <div className="finance-stat"><p>收到退款</p><strong>{money(summary.refundCents)}</strong><span>{summary.refundCount} 笔</span></div><div className="finance-stat"><p>收入</p><strong>{money(summary.incomeCents)}</strong><span>{summary.incomeCount} 笔</span></div><div className="finance-stat"><p>支出减退款</p><strong>{money(summary.netExpenseCents)}</strong><span>跨期退款不等于本月消费成本</span></div>
      </section>
      <div className="finance-charts"><section className="finance-card"><div className="finance-card-title"><h2>花费去了哪里</h2><div className="finance-switch" aria-label="支出分组方式"><button aria-pressed={groupBy === "area"} onClick={() => setGroupBy("area")}>生活领域</button><button aria-pressed={groupBy === "category"} onClick={() => setGroupBy("category")}>账单分类</button></div></div><p className="finance-caption">按已支付支出统计，退款单独展示。</p>
        {groups.length ? <div className="finance-area-bars">{groups.map(([label, cents]) => <div className="finance-area-bar" key={label}><div><span>{label}</span><strong>{money(cents)}</strong></div><div className="finance-bar-track"><span style={{ width: `${summary.expenseCents ? cents / summary.expenseCents * 100 : 0}%` }} /></div></div>)}</div> : <p className="finance-chart-empty">这段时间没有已支付支出。</p>}
        <p className="finance-fixed">自己标记的固定开销 <strong>{money(fixedCents)}</strong><span>仅统计手动标记的已支付支出</span></p>
      </section><section className="finance-card"><h2>月份之间</h2><p className="finance-caption">每月已支付支出 · 点击月份查看。不完整月份也会保留。</p><div className="finance-trend">{trends.map((item) => <button className="finance-trend-item" key={item.month} aria-pressed={month === item.month} aria-label={`${monthLabel(item.month)}，支出 ${money(item.cents)}`} onClick={() => selectMonth(item.month)}><span className="finance-trend-date">{item.month}</span><span className="finance-trend-track"><span style={{ width: `${item.cents / maxTrend * 100}%` }} /></span><strong>{money(item.cents)}</strong></button>)}</div></section></div>
      <section ref={ledger} tabIndex={-1} className="finance-ledger" aria-labelledby={`${id}-ledger`}><div className="finance-card-title"><div><h2 id={`${id}-ledger`}>账单明细</h2><p className="finance-caption">搜索与下方筛选只影响明细，概览仍按回看时间统计。</p></div><span className="finance-ledger-count">{filtered.length} 笔记录</span></div>
        <div className="finance-flow-context"><span>不计收支 {summary.neutralCount} 笔 · {money(summary.neutralCents)}</span><span>处理中 {summary.pendingCount} 笔 · {money(summary.pendingCents)}</span><span>已关闭 {summary.closedCount} 笔 · {money(summary.closedCents)}</span></div>
        <div className="finance-filters"><label htmlFor={`${id}-search`}>搜索账单<input id={`${id}-search`} type="search" value={search} placeholder="商品、交易对方或备注" onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label><label htmlFor={`${id}-area`}>生活领域<select id={`${id}-area`} value={area} onChange={(event) => { setArea(event.target.value); setPage(1); }}><option value="">全部领域</option>{FINANCE_AREAS.map((value) => <option key={value}>{value}</option>)}</select></label><label htmlFor={`${id}-kind`}>收支类型<select id={`${id}-kind`} value={kind} onChange={(event) => { setKind(event.target.value); setPage(1); }}><option value="">全部类型</option><option value="expense">支出</option><option value="refund">退款</option><option value="income">收入</option><option value="other">不计收支 / 处理中 / 已关闭</option></select></label></div>
        <div className="finance-transactions">{filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((row) => <TransactionCard key={row.id} row={row} context={context} saving={saving} onSave={saveAnnotation} />)}{!filtered.length && <p className="finance-chart-empty">没有符合筛选条件的记录。</p>}</div>
        <nav className="finance-pagination" aria-label="账单分页"><span aria-live="polite">{filtered.length ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} / ${filtered.length} 笔` : "0 笔"}</span><div><button disabled={currentPage <= 1} onClick={() => changePage(currentPage - 1)}>上一页</button><label htmlFor={`${id}-page`} className="finance-page-select"><span className="finance-sr-only">选择页码</span><select id={`${id}-page`} value={currentPage} onChange={(event) => changePage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option value={index + 1} key={index}>第 {index + 1} / {pages} 页</option>)}</select></label><button disabled={currentPage >= pages} onClick={() => changePage(currentPage + 1)}>下一页</button></div></nav>
      </section><p className="finance-local-note">账单在本机保存，换设备前可从页脚导出备份。</p>
    </>}
  </section>;
}
