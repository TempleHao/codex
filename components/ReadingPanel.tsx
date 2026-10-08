"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formatReadingSeconds, isSafeReadingLink, mergeReadingLibraries, parseReadingImport, type ReadingBook, type ReadingLibrary } from "@/lib/reading";
import type { Area } from "@/lib/types";
import "./reading.css";

export type ReadingTaskDraft = { title: string; notes: string; area?: Area };
export type ReadingThoughtDraft = { title: string; body: string; bookId?: string; highlightId?: string; sourceExcerpt?: string };

export interface ReadingPanelProps {
  library: ReadingLibrary;
  onLibraryChange: (next: ReadingLibrary) => Promise<void>;
  onCreateTask: (input: ReadingTaskDraft) => void | Promise<void>;
  onCreateThought: (input: ReadingThoughtDraft) => void | Promise<void>;
}

const STATUS_LABELS: Record<ReadingBook["status"], string> = { wanted: "想读", reading: "在读", finished: "读完" };
const KIND_LABELS: Record<ReadingBook["kind"], string> = { ebook: "电子书", audiobook: "有声书", article: "文章" };
const MODE_LABELS = { weekly: "周统计", monthly: "月统计", annually: "年度统计", overall: "累计" };
const FORMAT_EXAMPLE = JSON.stringify({ version: 1, source: "manual", items: [{ id: "your-book-id", title: "替换为你的书名", author: "作者", kind: "ebook", status: "reading" }], highlights: [{ id: "your-highlight-id", bookId: "your-book-id", text: "替换为你想留下的原文", thought: "你自己的想法", chapter: "章节名称" }], stats: null, syncedAt: null }, null, 2);

function ReadingIcon({ name, size = 20 }: { name: "book" | "plus" | "upload" | "download" | "search" | "close" | "arrow" | "note"; size?: number }) {
  const shapes: Record<typeof name, ReactNode> = {
    book: <><path d="M12 5C8 3 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-1-10 1Z"/><path d="M12 5v15M5 7h3M5 10h3M16 7h3M16 10h3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    note: <><path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h6"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}

/** Reading links only open WeRead destinations, and never load while browsing the shelf. */
function trustedReadingLink(value?: string): string | null {
  if (!value || !isSafeReadingLink(value)) return null;
  const url = new URL(value);
  return url.protocol === "weread:" || (url.protocol === "https:" && (url.hostname === "weread.qq.com" || url.hostname.endsWith(".weread.qq.com"))) ? value : null;
}

function trustedReadingCover(value?: string): string | null {
  if (!value || !isSafeReadingLink(value)) return null;
  const url = new URL(value);
  return url.protocol === "https:" && ["qq.com", "qpic.cn"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? value : null;
}

function displayReadingDate(value?: string | null): string {
  if (!value) return "尚未导入";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚未导入" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Shanghai", ...(!/^\d{4}-\d{2}-\d{2}$/.test(value) ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(date);
}

function ReadingInsights({ library }: { library: ReadingLibrary }) {
  const [chosenYear, setChosenYear] = useState<string | null>(null);
  const daily = library.stats?.dailySeconds ?? [];
  const years = Array.from(new Set(daily.map(day => day.date.slice(0, 4)))).sort().reverse();
  const year = chosenYear && years.includes(chosenYear) ? chosenYear : years[0] ?? String(new Date().getFullYear());
  const yearDays = daily.filter(day => day.date.startsWith(`${year}-`));
  const dayMap = new Map(yearDays.map(day => [day.date, day.seconds]));
  const yearSeconds = yearDays.reduce((sum, day) => sum + day.seconds, 0);
  const activeDays = yearDays.filter(day => day.seconds > 0).length;
  const maxSeconds = yearDays.reduce((maximum, day) => Math.max(maximum, day.seconds), 1);
  const firstDay = new Date(`${year}-01-01T00:00:00Z`);
  const calendarYear = Number(year);
  const totalDays = calendarYear % 4 === 0 && (calendarYear % 100 !== 0 || calendarYear % 400 === 0) ? 366 : 365;
  const offset = (firstDay.getUTCDay() + 6) % 7;
  const calendar = Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(firstDay.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    const seconds = dayMap.get(date);
    const intensity = seconds === undefined ? "missing" : seconds <= 0 ? "0" : seconds < maxSeconds * .2 ? "1" : seconds < maxSeconds * .45 ? "2" : seconds < maxSeconds * .75 ? "3" : "4";
    return { date, seconds, intensity, row: (offset + index) % 7 + 1, column: Math.floor((offset + index) / 7) + 1 };
  });
  const ranking = library.books.filter(book => typeof book.secondsRead === "number").slice().sort((a, b) => (b.secondsRead ?? 0) - (a.secondsRead ?? 0)).slice(0, 4);
  const preferred = (library.stats?.preferredHours ?? []).filter(item => item.seconds > 0).slice().sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  return <div className="reading-insights">
    <section className="reading-year-card" aria-labelledby="reading-year-heading"><header><div><p className="section-kicker">A YEAR IN PAGES</p><h2 id="reading-year-heading">阅读留下的日子</h2></div>{years.length > 0 && <><label className="reading-sr-only" htmlFor="reading-year">选择统计年份</label><select id="reading-year" value={year} onChange={event => setChosenYear(event.target.value)}>{years.map(value => <option key={value} value={value}>{value} 年</option>)}</select></>}</header>{yearDays.length ? <><div className="reading-year-summary"><strong>{formatReadingSeconds(yearSeconds)}</strong><span>{year} 年已导入记录 · {activeDays} 天有阅读</span></div><div className="reading-heatmap-scroll"><div className="reading-heatmap-months" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <span key={index}>{index + 1}月</span>)}</div><div className="reading-heatmap-body"><div className="reading-heatmap-weekdays" aria-hidden="true"><span>一</span><span>三</span><span>日</span></div><div className="reading-heatmap" role="img" aria-label={`${year}年已导入${yearDays.length}天的记录，${activeDays}天有阅读，共${formatReadingSeconds(yearSeconds)}。空白日期表示未导入数据。`}>{calendar.map(day => <span key={day.date} className={`reading-heat-cell reading-heat-${day.intensity}`} style={{ gridRow: day.row, gridColumn: day.column }} title={`${day.date} · ${day.seconds === undefined ? "未导入数据" : formatReadingSeconds(day.seconds)}`}/>)}</div></div></div><div className="reading-heatmap-legend"><span>未导入 <i className="reading-heat-cell reading-heat-missing"/></span><span>少 <i className="reading-heat-cell reading-heat-0"/><i className="reading-heat-cell reading-heat-1"/><i className="reading-heat-cell reading-heat-2"/><i className="reading-heat-cell reading-heat-3"/><i className="reading-heat-cell reading-heat-4"/> 多</span></div><p className="reading-data-note">左右滑动查看全年；按已导入的每日阅读秒数显示，空白表示未导入。</p></> : <div className="reading-insight-empty"><ReadingIcon name="book" size={30}/><p>读过的日子，会在这里慢慢生长。</p><span>导入每日阅读记录后，查看年度热力图与时长。</span></div>}</section>
    <section className="reading-ranking" aria-labelledby="reading-ranking-heading"><p className="section-kicker">TIME WELL SPENT</p><h2 id="reading-ranking-heading">读得最多的书</h2>{ranking.length ? <ol>{ranking.map((book, index) => <li key={book.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{book.title}</strong><small>{formatReadingSeconds(book.secondsRead ?? 0)}</small></div></li>)}</ol> : <p className="reading-insight-hint">导入每本书的阅读时长后，这里会留下你投入最多时间的书。</p>}</section>
    <section className="reading-preferences" aria-labelledby="reading-preference-heading"><p className="section-kicker">YOUR READING RHYTHM</p><h2 id="reading-preference-heading">常读时段</h2>{preferred.length ? <ul>{preferred.map(item => <li key={item.hour}><span>{String(item.hour).padStart(2, "0")}:00 — {String((item.hour + 1) % 24).padStart(2, "0")}:00</span><strong>{formatReadingSeconds(item.seconds)}</strong></li>)}</ul> : <p className="reading-insight-hint">尚未导入阅读时段。让真实的记录，慢慢勾勒你的阅读习惯。</p>}</section>
  </div>;
}

function ReadingDialog({ title, titleId, busy, onClose, children }: { title: string; titleId: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
      if (event.key !== "Tab") return;
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary') ?? []);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="reading-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={ref} className="reading-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <div className="reading-dialog-header"><div><p className="section-kicker">A LITTLE SPACE FOR READING</p><h2 id={titleId}>{title}</h2></div><button type="button" className="reading-icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><ReadingIcon name="close"/></button></div>
      {children}
    </div>
  </div>;
}

export default function ReadingPanel({ library, onLibraryChange, onCreateTask, onCreateThought }: ReadingPanelProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ReadingBook["status"] | "all">("all");
  const [kindFilter, setKindFilter] = useState<ReadingBook["kind"] | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"highlights" | "thoughts">("highlights");
  const [showCovers, setShowCovers] = useState(false);
  const [failedCovers, setFailedCovers] = useState<Set<string>>(() => new Set());
  const [modal, setModal] = useState<"add" | "import" | null>(null);
  const [bookForm, setBookForm] = useState({ title: "", author: "", kind: "ebook" as ReadingBook["kind"], status: "wanted" as ReadingBook["status"] });
  const [importText, setImportText] = useState("");
  const [importDraft, setImportDraft] = useState<ReadingLibrary | null>(null);
  const [isExample, setIsExample] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  const filteredBooks = library.books.filter(book => statusFilter === "all" || book.status === statusFilter).filter(book => kindFilter === "all" || book.kind === kindFilter).filter(book => `${book.title} ${book.author}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedBook = filteredBooks.find(book => book.id === selectedId) ?? filteredBooks[0] ?? null;
  const selectedHighlights = selectedBook ? library.highlights.filter(item => item.bookId === selectedBook.id) : [];
  const tabHighlights = selectedHighlights.filter(item => detailTab === "highlights" ? Boolean(item.text.trim()) : Boolean(item.thought?.trim()));
  const readingLink = trustedReadingLink(selectedBook?.deepLink);
  const readingCount = library.books.filter(book => book.status === "reading").length;
  const finishedCount = library.books.filter(book => book.status === "finished").length;
  const blockedCovers = showCovers && library.books.some(book => book.cover && !trustedReadingCover(book.cover));

  function closeModal() { if (!busy) { setModal(null); setModalError(""); } }
  function navigateDetailTabs(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "highlights" : event.key === "End" ? "thoughts" : detailTab === "highlights" ? "thoughts" : "highlights";
    setDetailTab(next);
    document.getElementById(next === "highlights" ? "reading-highlight-tab" : "reading-thought-tab")?.focus();
  }
  function openAdd() { setBookForm({ title: "", author: "", kind: "ebook", status: "wanted" }); setModalError(""); setModal("add"); }
  function openImport() { setModalError(""); setModal("import"); }
  function errorText(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }

  async function saveBook(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!bookForm.title.trim()) { setModalError("请填写书名。"); return; }
    setBusy("add"); setModalError("");
    const book: ReadingBook = { id: `manual-${crypto.randomUUID()}`, ...bookForm, title: bookForm.title.trim(), author: bookForm.author.trim() };
    try {
      await onLibraryChange({ ...library, books: [...library.books, book] });
      setSelectedId(book.id); setSearch(""); setStatusFilter("all"); setKindFilter("all"); setMessage(`已把《${book.title}》放进书架。`); setModal(null);
    } catch (cause) { setModalError(errorText(cause, "保存失败，填写的内容已保留。")); }
    finally { setBusy(null); }
  }

  async function changeBookStatus(book: ReadingBook, status: ReadingBook["status"]) {
    if (busy || book.status === status) return;
    setBusy(`status-${book.id}`); setError("");
    try { await onLibraryChange({ ...library, books: library.books.map(item => item.id === book.id ? { ...item, status, finished: status === "finished" } : item) }); setMessage(`《${book.title}》已标记为${STATUS_LABELS[status]}。`); }
    catch (cause) { setError(errorText(cause, "更新失败，请重试。")); }
    finally { setBusy(null); }
  }

  async function runAction(key: string, action: () => void | Promise<void>) {
    if (busy) return;
    setBusy(key); setError("");
    try { await action(); }
    catch (cause) { setError(errorText(cause, "暂时无法打开表单，请重试。")); }
    finally { setBusy(null); }
  }

  function previewImport() {
    if (busy) return;
    setModalError(""); setImportDraft(null);
    try { setImportDraft(parseReadingImport(importText)); }
    catch (cause) { setModalError(errorText(cause, "没有找到可导入的阅读资料，请检查格式。")); }
  }

  async function readFile(file?: File) {
    if (!file || busy) return;
    setBusy("file"); setModalError(""); setImportDraft(null);
    try {
      if (file.size > 2_000_000) throw new Error("阅读文件过大，请选择小于 2 MB 的 JSON 文件。");
      const value = await file.text(); setImportText(value); setIsExample(false); setImportDraft(parseReadingImport(value));
    } catch (cause) { setModalError(errorText(cause, "文件读取失败，请重试。")); }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function confirmImport() {
    if (!importDraft || busy) return;
    setBusy("import"); setModalError("");
    try {
      const next = mergeReadingLibraries(library, importDraft);
      await onLibraryChange(next); setMessage(`已导入 ${importDraft.books.length} 本书、${importDraft.highlights.length} 条划线与想法。`); setModal(null); setImportDraft(null); setImportText(""); setIsExample(false);
    } catch (cause) { setModalError(errorText(cause, "导入失败，预览内容已保留。")); }
    finally { setBusy(null); }
  }

  function exportReading() {
    if (busy) return;
    setError("");
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `有序-阅读-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url); setMessage("阅读资料已导出。完整备份也会包含书架和思考。");
    } catch (cause) { setError(errorText(cause, "导出失败，请重试。")); }
  }

  return <section className="reading-panel-root" aria-labelledby="reading-title">
    <header className="reading-intro"><div><p className="eyebrow">A LIFE IN BOOKS</p><h1 id="reading-title">把读过的书，慢慢留住。</h1><p>留下书籍、句子与感受，回看自己一路的阅读兴趣。</p></div><div className="reading-header-actions"><button className="button secondary" type="button" onClick={openImport} disabled={Boolean(busy)}><ReadingIcon name="upload" size={16}/>导入阅读 JSON</button><button className="button primary" type="button" onClick={openAdd} disabled={Boolean(busy)}><ReadingIcon name="plus" size={17}/>添加书籍</button></div></header>
    <div className="reading-local-note"><ReadingIcon name="note" size={17}/><p>阅读资料留在当前浏览器。微信读书书单、划线和本人想法可以通过 JSON 导入，记得定期导出完整备份。</p></div>
    <div className="reading-feedback" aria-live="polite">{message && <p className="reading-success">{message}<button type="button" onClick={() => setMessage("")} aria-label="关闭提示"><ReadingIcon name="close" size={15}/></button></p>}</div>
    {error && <p className="reading-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="关闭错误提示"><ReadingIcon name="close" size={15}/></button></p>}
    <div className="reading-overview">
      <div className="reading-stat"><span>已收录的阅读条目<small>在读 {readingCount} 本</small></span><strong>{library.books.length}<small>项</small></strong></div>
      <div className="reading-stat"><span>阅读时长<small>{library.stats ? `${MODE_LABELS[library.stats.mode]} · 来自已导入统计` : "导入统计后显示"}</small></span><strong className="reading-duration">{library.stats ? formatReadingSeconds(library.stats.totalSeconds) : "—"}</strong></div>
      <div className="reading-stat"><span>阅读日数<small>{library.stats?.readingDays !== undefined ? `${MODE_LABELS[library.stats.mode]} · 来自已导入统计` : "导入统计后显示"}</small></span><strong>{library.stats?.readingDays ?? "—"}<small>天</small></strong></div>
      <div className="reading-stat"><span>已经读完<small>每读完一本，留下一个回响</small></span><strong>{finishedCount}<small>本</small></strong></div>
    </div>
    <ReadingInsights library={library}/>
    <div className="reading-layout">
      <section className="reading-shelf" aria-labelledby="reading-shelf-title">
        <div className="reading-section-heading"><div><p className="section-kicker">MY BOOKSHELF</p><h2 id="reading-shelf-title">我的书架 <span className="count-pill">{filteredBooks.length}</span></h2></div><button className="text-button" type="button" onClick={exportReading} disabled={Boolean(busy)}><ReadingIcon name="download" size={14}/>导出阅读</button></div>
        <div className="reading-tools"><label className="reading-search" htmlFor="reading-search"><ReadingIcon name="search" size={17}/><input id="reading-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索书名或作者"/></label><div className="reading-select-filters"><label className="reading-sr-only" htmlFor="reading-status">按阅读状态筛选</label><select id="reading-status" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">全部状态</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><label className="reading-sr-only" htmlFor="reading-kind">按书籍类型筛选</label><select id="reading-kind" value={kindFilter} onChange={event => setKindFilter(event.target.value as typeof kindFilter)}><option value="all">全部类型</option>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
        <div className="reading-shelf-preferences"><label className="reading-cover-toggle"><input type="checkbox" checked={showCovers} onChange={event => setShowCovers(event.target.checked)}/>显示书籍封面</label><span>{blockedCovers ? "仅加载腾讯官方域名的封面，其他图片保留文字封面。" : "开启后加载官方图片；本次页面有效。"}</span></div>
        {filteredBooks.length ? <div className="reading-books">{filteredBooks.map(book => <button type="button" key={book.id} className={`reading-book-card ${selectedBook?.id === book.id ? "selected" : ""}`} aria-pressed={selectedBook?.id === book.id} onClick={() => { setSelectedId(book.id); if (window.matchMedia("(max-width: 960px)").matches) detailRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}><div className={`reading-book-cover reading-cover-${book.kind} ${showCovers && trustedReadingCover(book.cover) && !failedCovers.has(`${book.id}|${book.cover}`) ? "has-image" : ""}`}>{showCovers && trustedReadingCover(book.cover) && !failedCovers.has(`${book.id}|${book.cover}`) ? <img src={trustedReadingCover(book.cover)!} alt={book.title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedCovers(previous => new Set(previous).add(`${book.id}|${book.cover}`))}/> : <><span aria-hidden="true">{book.title.slice(0, 1)}</span><small aria-hidden="true">{KIND_LABELS[book.kind]}</small></>}</div><div className="reading-book-info"><strong>{book.title}</strong><span>{book.author || "作者未填写"}</span><div className="reading-book-meta"><span className={`reading-status-tag reading-status-${book.status}`}>{STATUS_LABELS[book.status]}</span>{typeof book.progress === "number" && <span>已读 {Math.round(book.progress)}%</span>}</div></div><span className="reading-card-arrow"><ReadingIcon name="arrow" size={17}/></span></button>)}</div> : <div className="reading-empty"><div className="reading-empty-icon"><ReadingIcon name="book" size={38}/></div><h3>{library.books.length ? "没有找到这本书" : "给一本书，留个位置"}</h3><p>{library.books.length ? "试试其他书名或作者，或调整筛选条件。" : "从手边正在读的那本开始，也可以导入你的书单、划线和想法。"}</p><button type="button" className="button secondary" onClick={library.books.length ? () => { setSearch(""); setStatusFilter("all"); setKindFilter("all"); } : openAdd}>{library.books.length ? "清除筛选" : "添加第一本书"}</button></div>}
        <div className="reading-shelf-footer"><span>最近同步：{displayReadingDate(library.syncedAt)}</span><span>{library.source === "weread" ? "微信读书资料" : "手动整理"}</span></div>
      </section>
      <aside ref={detailRef} className="reading-detail" aria-labelledby="reading-detail-title">
        {selectedBook ? <><p className="section-kicker">BETWEEN THE LINES</p><div className="reading-detail-title"><span>{KIND_LABELS[selectedBook.kind]}</span><h2 id="reading-detail-title">{selectedBook.title}</h2><p>{selectedBook.author || "作者未填写"}</p></div><label className="reading-detail-status" htmlFor="reading-book-status">阅读状态<select id="reading-book-status" value={selectedBook.status} disabled={Boolean(busy)} onChange={event => void changeBookStatus(selectedBook, event.target.value as ReadingBook["status"])}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {(typeof selectedBook.progress === "number" || typeof selectedBook.secondsRead === "number" || selectedBook.lastReadAt) && <dl className="reading-book-facts">{typeof selectedBook.progress === "number" && <div><dt>阅读进度</dt><dd>{Math.round(selectedBook.progress)}%</dd></div>}{typeof selectedBook.secondsRead === "number" && <div><dt>本书时长</dt><dd>{formatReadingSeconds(selectedBook.secondsRead)}</dd></div>}{selectedBook.lastReadAt && <div><dt>最近阅读</dt><dd>{displayReadingDate(selectedBook.lastReadAt)}</dd></div>}</dl>}
          {readingLink && <div className="reading-book-actions"><a className="button secondary" href={readingLink} target="_blank" rel="noopener noreferrer">打开阅读<ReadingIcon name="arrow" size={14}/></a></div>}
          <details className="reading-transaction-tools reading-book-transaction-tools"><summary>事务工具</summary><p>需要为这本书留出时间时，可以打开待办草稿。</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void runAction(`task-${selectedBook.id}`, () => onCreateTask({ title: `阅读《${selectedBook.title}》`, notes: [selectedBook.author && `作者：${selectedBook.author}`, "给这本书留一段阅读时间。"].filter(Boolean).join("\n"), area: "阅读" }))}>{busy === `task-${selectedBook.id}` ? "打开中…" : "安排阅读"}</button></details>
          <section className="reading-highlights" aria-labelledby="reading-highlights-title">
            <h3 id="reading-highlights-title" className="reading-sr-only">划线与本人想法</h3>
            <div className="reading-detail-tabs" role="tablist" aria-label="阅读笔记类型"><button id="reading-highlight-tab" type="button" role="tab" tabIndex={detailTab === "highlights" ? 0 : -1} onKeyDown={navigateDetailTabs} aria-selected={detailTab === "highlights"} aria-controls="reading-note-content" className={detailTab === "highlights" ? "active" : ""} onClick={() => setDetailTab("highlights")}>划线 <span>{selectedHighlights.filter(item => item.text.trim()).length}</span></button><button id="reading-thought-tab" type="button" role="tab" tabIndex={detailTab === "thoughts" ? 0 : -1} onKeyDown={navigateDetailTabs} aria-selected={detailTab === "thoughts"} aria-controls="reading-note-content" className={detailTab === "thoughts" ? "active" : ""} onClick={() => setDetailTab("thoughts")}>本人想法 <span>{selectedHighlights.filter(item => item.thought?.trim()).length}</span></button></div>
            <div id="reading-note-content" role="tabpanel" aria-labelledby={detailTab === "highlights" ? "reading-highlight-tab" : "reading-thought-tab"}>
              {tabHighlights.length ? tabHighlights.map(highlight => <article className="reading-highlight" key={highlight.id}>
                {highlight.chapter && <p className="reading-chapter">{highlight.chapter}</p>}
                {detailTab === "highlights" && <blockquote>{highlight.text}</blockquote>}
                {detailTab === "thoughts" && <><div className="reading-own-thought"><p>{highlight.thought}</p></div>{highlight.text && <details className="reading-thought-excerpt"><summary>回看原摘录</summary><blockquote>{highlight.text}</blockquote></details>}</>}
                {highlight.createdAt && <time className="reading-highlight-date" dateTime={highlight.createdAt}>{displayReadingDate(highlight.createdAt)}</time>}
                <div className="reading-highlight-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void runAction(`thought-${highlight.id}`, () => onCreateThought({ title: `读《${selectedBook.title}》有感`, body: highlight.thought || "", bookId: selectedBook.id, highlightId: highlight.id, sourceExcerpt: highlight.text }))}>写一段思考<ReadingIcon name="note" size={13}/></button><details className="reading-transaction-tools reading-highlight-transaction-tools"><summary>事务工具</summary><p>这段摘录涉及具体的事时，可以另开一份待办草稿。</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void runAction(`highlight-task-${highlight.id}`, () => onCreateTask({ title: `实践《${selectedBook.title}》中的一个想法`, notes: [highlight.text, highlight.thought && `我的想法：${highlight.thought}`].filter(Boolean).join("\n\n"), area: "阅读" }))}>把摘录变成行动<ReadingIcon name="arrow" size={13}/></button></details></div>
              </article>) : <div className="reading-no-highlights"><ReadingIcon name="note" size={24}/><p>{detailTab === "thoughts" ? "你自己的想法，会留在这里。" : "有触动的句子，可以留在这里。"}</p><span>导入这本书的{detailTab === "thoughts" ? "本人想法" : "划线"}后，可以随时回看，也可以继续写下感受。</span></div>}
            </div>
          </section>
        </> : <div className="reading-detail-placeholder"><ReadingIcon name="note" size={32}/><h2 id="reading-detail-title">一本书，一点回响。</h2><p>选择书架上的一本书，查看它的划线与想法。</p></div>}
      </aside>
    </div>
    <details className="reading-format-help"><summary>如何整理微信读书资料与导入格式</summary><p>可使用下方微信读书同步，或通过 JSON 导入书籍、划线与本人想法。同步资料需先解锁、预览，确认后才保存；相同编号会更新，其他书籍和划线会保留。</p><p>书籍类型 kind：ebook / audiobook / article；状态 status：wanted / reading / finished。划线通过 bookId 对应书籍 id；统计 totalSeconds 使用秒，readingDays 使用实际阅读日数。来源时间 syncedAt 可填写带时区的 ISO 时间。</p><p>点击“导入阅读 JSON”中的“查看格式样例”，替换为自己的内容后预览。阅读导出用于移交书架资料；页脚完整备份还会包含待办和思考。</p></details>
    {modal === "add" && <ReadingDialog title="给一本书，留个位置。" titleId="reading-add-title" busy={Boolean(busy)} onClose={closeModal}><form onSubmit={event => void saveBook(event)}><div className="reading-dialog-body"><p className="reading-dialog-description">从想读、在读或刚刚读完的那本开始。</p><fieldset className="reading-form-grid" disabled={Boolean(busy)}><label className="field reading-field-full" htmlFor="new-book-title">书名<input id="new-book-title" required maxLength={500} value={bookForm.title} onChange={event => setBookForm({ ...bookForm, title: event.target.value })} placeholder="你想留下的那本书"/></label><label className="field reading-field-full" htmlFor="new-book-author">作者<input id="new-book-author" maxLength={500} value={bookForm.author} onChange={event => setBookForm({ ...bookForm, author: event.target.value })} placeholder="可以稍后补充"/></label><label className="field" htmlFor="new-book-kind">书籍类型<select id="new-book-kind" value={bookForm.kind} onChange={event => setBookForm({ ...bookForm, kind: event.target.value as ReadingBook["kind"] })}>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field" htmlFor="new-book-status">阅读状态<select id="new-book-status" value={bookForm.status} onChange={event => setBookForm({ ...bookForm, status: event.target.value as ReadingBook["status"] })}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></fieldset>{modalError && <p className="reading-error" role="alert">{modalError}</p>}</div><div className="reading-dialog-footer"><span>保存到当前浏览器的书架</span><div><button type="button" className="button secondary" onClick={closeModal} disabled={Boolean(busy)}>取消</button><button type="submit" className="button primary" disabled={Boolean(busy)}>{busy === "add" ? "保存中…" : "放进书架"}</button></div></div></form></ReadingDialog>}
    {modal === "import" && <ReadingDialog title="把阅读的收获，收进来。" titleId="reading-import-title" busy={Boolean(busy)} onClose={closeModal}><div className="reading-dialog-body"><p className="reading-dialog-description">选择 JSON 文件，或粘贴已整理好的资料。先预览，再保存到书架。</p><input type="file" accept="application/json,.json" className="reading-sr-only" ref={fileRef} onChange={event => void readFile(event.target.files?.[0])} tabIndex={-1} aria-label="选择阅读 JSON 文件"/><div className="reading-import-tools"><button type="button" className="button secondary" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}><ReadingIcon name="upload" size={15}/>{busy === "file" ? "读取中…" : "选择 JSON 文件"}</button><button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => { setImportText(FORMAT_EXAMPLE); setImportDraft(null); setIsExample(true); setModalError(""); }}>查看格式样例</button></div>{isExample && <p className="reading-example-note">格式样例 · 尚未保存，请替换为自己的内容。</p>}<label className="field" htmlFor="reading-import-json">阅读资料 JSON<textarea id="reading-import-json" className="reading-json-input" rows={10} value={importText} disabled={Boolean(busy)} onChange={event => { setImportText(event.target.value); setImportDraft(null); setIsExample(false); }} placeholder="粘贴书籍、划线与本人想法的 JSON"/></label><button type="button" className="button secondary reading-preview-button" disabled={Boolean(busy) || !importText.trim()} onClick={previewImport}>预览资料<ReadingIcon name="arrow" size={15}/></button>{modalError && <p className="reading-error" role="alert">{modalError}</p>}{importDraft && <div className="reading-import-preview"><h3>这次导入</h3><p><strong>{importDraft.books.length}</strong> 本书 <span>·</span> <strong>{importDraft.highlights.length}</strong> 条划线与想法 {importDraft.stats && <span>· {formatReadingSeconds(importDraft.stats.totalSeconds)} / {importDraft.stats.readingDays ?? "未知"} 天</span>}</p>{importDraft.books.length > 0 && <ul>{importDraft.books.slice(0, 5).map(book => <li key={book.id}><span>{book.title}</span><small>{STATUS_LABELS[book.status]}</small></li>)}</ul>}{importDraft.books.length > 5 && <p className="reading-preview-more">另有 {importDraft.books.length - 5} 本书</p>}<p className="reading-preview-note">相同编号的资料会更新，其他阅读资料保留。{importDraft.syncedAt && `来源同步时间：${displayReadingDate(importDraft.syncedAt)}`}</p></div>}</div><div className="reading-dialog-footer"><span>资料只保存到当前浏览器</span><div><button type="button" className="button secondary" onClick={closeModal} disabled={Boolean(busy)}>取消</button><button type="button" className="button primary" onClick={() => void confirmImport()} disabled={Boolean(busy) || !importDraft}>{busy === "import" ? "导入中…" : "确认导入"}</button></div></div></ReadingDialog>}
  </section>;
}
