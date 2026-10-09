"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type FormEvent } from "react";
import type { BlogArchive, BlogEntry } from "@/lib/blog";
import type { LifeThought } from "@/lib/life";
import { isSafeReadingLink, type ReadingLibrary } from "@/lib/reading";
import type { Area } from "@/lib/types";
import "./reading.css";
import "./thoughts.css";

export interface ThoughtsPanelInitialDraft {
  title: string;
  body: string;
  bookId?: string;
  highlightId?: string;
  sourceExcerpt?: string;
}

export interface ThoughtsPanelProps {
  thoughts: LifeThought[];
  onThoughtsChange: (next: LifeThought[]) => Promise<void>;
  onCreateTask: (task: { title: string; notes: string; area?: Area }) => void | Promise<void>;
  library?: ReadingLibrary;
  blog?: BlogArchive;
  blogStatus?: ReactNode;
  revisit?: ReactNode;
  blogRequest?: string | null;
  onBlogRequestConsumed?: () => void;
  initialDraft?: ThoughtsPanelInitialDraft | null;
  onDraftConsumed?: () => void;
}

type ThoughtDraft = {
  id: string | null;
  title: string;
  body: string;
  bookId: string;
  highlightId?: string;
  sourceExcerpt: string;
};

type EditorState = { draft: ThoughtDraft; initial: ThoughtDraft; originalUpdatedAt: string | null };
type BusyAction = { kind: "save" | "delete" | "task"; id?: string };
const PAGE_SIZE = 15;

function sourceDraftKey(draft: ThoughtsPanelInitialDraft): string {
  return JSON.stringify([draft.title, draft.body, draft.bookId ?? "", draft.highlightId ?? "", draft.sourceExcerpt ?? ""]);
}

function draftFor(thought?: LifeThought, fallbackExcerpt?: string): ThoughtDraft {
  return {
    id: thought?.id ?? null,
    title: thought?.title ?? "",
    body: thought?.body ?? "",
    bookId: thought?.bookId ?? "",
    highlightId: thought?.highlightId,
    sourceExcerpt: thought?.sourceExcerpt ?? fallbackExcerpt ?? "",
  };
}

function changedDraft(editor: EditorState): boolean {
  const { draft, initial } = editor;
  if (!draft.id) return Boolean(draft.title.trim() || draft.body.trim() || draft.bookId || draft.highlightId || draft.sourceExcerpt.trim());
  return draft.title !== initial.title || draft.body !== initial.body
    || draft.bookId !== initial.bookId || draft.sourceExcerpt !== initial.sourceExcerpt;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "short", day: "numeric", timeZone: "Asia/Shanghai",
  }).format(date);
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message ? ` ${error.message}` : "";
}

function isOfficialReadingLink(value: string): boolean {
  if (!isSafeReadingLink(value)) return false;
  const url = new URL(value);
  return url.protocol === "weread:" || (url.protocol === "https:"
    && (url.hostname === "weread.qq.com" || url.hostname.endsWith(".weread.qq.com")));
}

function ThoughtIcon({ name }: { name: "note" | "plus" | "search" | "arrow" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "note" && <><path d="M7 3h12v18H5V5a2 2 0 0 1 2-2Z"/><path d="M9 8h6M9 12h6M9 16h4M5 3v18"/></>}
    {name === "plus" && <path d="M12 5v14M5 12h14"/>}
    {name === "search" && <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>}
    {name === "arrow" && <path d="M4 12h16m-6-6 6 6-6 6"/>}
  </svg>;
}

export default function ThoughtsPanel({ thoughts, onThoughtsChange, onCreateTask, library, initialDraft, onDraftConsumed, blog, blogStatus, revisit, blogRequest, onBlogRequestConsumed }: ThoughtsPanelProps) {
  const prefix = useId();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [year, setYear] = useState("");
  const [page, setPage] = useState(1);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const listTop = useRef<HTMLDivElement>(null);
  const focusPageStart = useRef(false);
  const wasEditorOpen = useRef(false);
  const consumedReadingDraft = useRef<string | null>(null);
  const working = useRef(false);

  const books = useMemo(() => new Map(library?.books.map(book => [book.id, book]) ?? []), [library?.books]);
  const highlights = useMemo(() => new Map(library?.highlights.map(highlight => [highlight.id, highlight]) ?? []), [library?.highlights]);
  const initialDraftKey = useMemo(() => initialDraft ? sourceDraftKey(initialDraft) : null, [initialDraft]);
  const timeline = useMemo(() => [
    ...thoughts.map(thought => ({ id: thought.id, date: thought.createdAt, local: thought, blog: undefined as BlogEntry | undefined })),
    ...(blog?.entries ?? []).map(entry => ({ id: entry.id, date: entry.date, local: undefined as LifeThought | undefined, blog: entry })),
  ].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || a.id.localeCompare(b.id)), [thoughts, blog?.entries]);
  const years = useMemo(() => [...new Set(timeline.map(item => item.date.slice(0, 4)))].sort().reverse(), [timeline]);
  const visibleThoughts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return timeline.filter(item => (source === "all" || (source === "blog" ? Boolean(item.blog) : Boolean(item.local)))
      && (!year || item.date.startsWith(year))
      && (!query || (item.local ? [item.local.title, item.local.body, item.local.sourceExcerpt ?? "", books.get(item.local.bookId ?? "")?.title ?? ""]
        : [item.blog!.title, item.blog!.text, item.blog!.author]).some(text => text.toLocaleLowerCase().includes(query))));
  }, [timeline, search, books, source, year]);
  const pageCount = Math.max(1, Math.ceil(visibleThoughts.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageThoughts = visibleThoughts.slice(pageStart, pageStart + PAGE_SIZE);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);
  useEffect(() => {
    if (!blogRequest) return;
    const index = timeline.findIndex(item => item.id === blogRequest);
    if (index < 0) return;
    focusPageStart.current = false;
    setSearch(""); setSource("all"); setYear(""); setPage(Math.floor(index / PAGE_SIZE) + 1); setFocusId(blogRequest);
    onBlogRequestConsumed?.();
  }, [blogRequest, timeline, onBlogRequestConsumed]);
  useEffect(() => {
    if (!focusId) return;
    const target = document.getElementById(`thought-${focusId}`);
    if (!target) return;
    target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center", behavior: "smooth" }); setFocusId(null);
  }, [focusId, currentPage, visibleThoughts]);
  useEffect(() => {
    if (!focusPageStart.current) return;
    focusPageStart.current = false;
    listTop.current?.focus({ preventScroll: true });
    listTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [currentPage]);

  function changePage(value: number) {
    const next = Math.max(1, Math.min(value, pageCount));
    if (next === currentPage) return;
    focusPageStart.current = true;
    setPage(next);
  }

  const editorInitial = editor?.initial;
  const editorOpen = Boolean(editor);
  useEffect(() => {
    if (editorOpen) titleInput.current?.focus();
    else if (wasEditorOpen.current) newButton.current?.focus();
    wasEditorOpen.current = editorOpen;
  }, [editorInitial, editorOpen]);

  useEffect(() => {
    if (!initialDraft) {
      consumedReadingDraft.current = null;
      return;
    }
    if (consumedReadingDraft.current === initialDraftKey || working.current || (editor && changedDraft(editor))) return;
    consumeReadingDraft(initialDraft);
  }, [initialDraft, initialDraftKey, onDraftConsumed, highlights, editor, busy]);

  function consumeReadingDraft(incoming: ThoughtsPanelInitialDraft) {
    const highlight = highlights.get(incoming.highlightId ?? "");
    const excerpt = highlight && highlight.bookId === incoming.bookId ? highlight.text : undefined;
    const draft: ThoughtDraft = {
      id: null,
      title: incoming.title.slice(0, 200),
      body: incoming.body,
      bookId: incoming.bookId ?? "",
      highlightId: incoming.highlightId,
      sourceExcerpt: incoming.sourceExcerpt ?? excerpt ?? "",
    };
    consumedReadingDraft.current = sourceDraftKey(incoming);
    setEditor({ draft, initial: { ...draft }, originalUpdatedAt: null });
    setError("");
    setStatus("阅读草稿已带入，检查后保存。");
    try { onDraftConsumed?.(); }
    catch (cause) { setError(`阅读草稿已打开，暂时无法清除待接收状态。${errorDetail(cause)}`); }
  }

  function acceptReadingDraft() {
    if (!initialDraft || consumedReadingDraft.current === initialDraftKey || working.current) return;
    if (editor && changedDraft(editor) && !window.confirm("当前思考还有未保存的内容。放弃当前草稿，接收阅读草稿吗？")) return;
    consumeReadingDraft(initialDraft);
  }

  function openEditor(thought?: LifeThought) {
    if (working.current) return;
    if (editor && changedDraft(editor) && !window.confirm("当前还有未保存的思考。放弃这份草稿，打开另一条吗？")) return;
    const highlight = highlights.get(thought?.highlightId ?? "");
    const excerpt = highlight && highlight.bookId === thought?.bookId ? highlight.text : undefined;
    const draft = draftFor(thought, excerpt);
    setEditor({ draft, initial: { ...draft }, originalUpdatedAt: thought?.updatedAt ?? null });
    setError("");
    setStatus("");
  }

  function reflectOnBlog(entry: BlogEntry) {
    if (working.current) return;
    if (editor && changedDraft(editor) && !window.confirm("放弃当前未保存的草稿，写下这次感受吗？")) return;
    const draft = draftFor();
    draft.title = `重读：${entry.title || entry.text.slice(0, 40) || "博客记录"}`.slice(0, 200);
    draft.sourceExcerpt = `${entry.text.slice(0, 19_000)}\n\n博客 · ${entry.author} · ${dateLabel(entry.date)}\n原文：${entry.sourceUrl}`.slice(0, 20_000);
    setEditor({ draft, initial: { ...draft }, originalUpdatedAt: null });
    setError(""); setStatus("原文已作为来源保留，写下今天自己的感受后保存。");
  }

  function closeEditor() {
    if (working.current) return;
    if (editor && changedDraft(editor) && !window.confirm("放弃这份尚未保存的思考草稿吗？")) return;
    setEditor(null);
    setError("");
    newButton.current?.focus();
  }

  function updateDraft(next: Partial<ThoughtDraft>) {
    setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, ...next } } : null);
  }

  async function saveThought(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || working.current) return;
    const draft = editor.draft;
    if (!draft.title.trim() || !draft.body.trim()) {
      setError("请填写思考标题和你的想法。");
      return;
    }
    working.current = true;
    setBusy({ kind: "save" });
    setError("");
    setStatus("");
    try {
      const previous = draft.id ? thoughts.find(thought => thought.id === draft.id) : undefined;
      if (draft.id && !previous) throw new Error("这条思考已不在列表中，请复制草稿后新建。");
      if (previous && previous.updatedAt !== editor.originalUpdatedAt) throw new Error("这条思考已有新的修改，请复制草稿后重新打开，避免覆盖新内容。");
      const now = new Date().toISOString();
      const saved: LifeThought = {
        id: previous?.id ?? crypto.randomUUID(),
        title: draft.title.trim(),
        body: draft.body.trim(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        ...(draft.bookId ? { bookId: draft.bookId } : {}),
        ...(draft.highlightId ? { highlightId: draft.highlightId } : {}),
        ...(draft.sourceExcerpt.trim() ? { sourceExcerpt: draft.sourceExcerpt } : {}),
      };
      const next = previous
        ? thoughts.map(thought => thought.id === previous.id ? saved : thought)
        : [...thoughts, saved];
      await onThoughtsChange(next);
      setEditor(null);
      setSearch(""); setSource("all"); setYear(""); setPage(1);
      setStatus(previous ? "思考已更新。" : "思考已保存。");
    } catch (cause) {
      setError(`保存失败，草稿仍保留在这里。${errorDetail(cause)}`);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  async function deleteThought(thought: LifeThought) {
    if (working.current) return;
    const draftWarning = editor && editor.draft.id === thought.id && changedDraft(editor) ? " 当前未保存的编辑也会被放弃。" : "";
    if (!window.confirm(`确定删除「${thought.title}」这条思考？删除后无法撤销。${draftWarning}`)) return;
    working.current = true;
    setBusy({ kind: "delete", id: thought.id });
    setError("");
    setStatus("");
    try {
      await onThoughtsChange(thoughts.filter(item => item.id !== thought.id));
      if (editor?.draft.id === thought.id) setEditor(null);
      setStatus("思考已删除。");
    } catch (cause) {
      setError(`删除失败，请重试。${errorDetail(cause)}`);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  async function createTask(thought: LifeThought) {
    if (working.current) return;
    working.current = true;
    setBusy({ kind: "task", id: thought.id });
    setError("");
    setStatus("");
    try {
      const book = books.get(thought.bookId ?? "");
      const highlight = highlights.get(thought.highlightId ?? "");
      const excerpt = thought.sourceExcerpt || (highlight && highlight.bookId === thought.bookId ? highlight.text : "");
      const notes = [thought.body, book ? `来自《${book.title}》` : "", excerpt ? `原摘录：\n${excerpt}` : ""].filter(Boolean).join("\n\n");
      await onCreateTask({ title: thought.title, notes, area: thought.bookId ? "阅读" : "思考" });
      setStatus("待办草稿已打开，请确认后保存。");
    } catch (cause) {
      setError(`暂时无法转为待办，请重试。${errorDetail(cause)}`);
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  const draft = editor?.draft;
  const selectedBookMissing = Boolean(draft?.bookId && !books.has(draft.bookId));
  const filtered = Boolean(search.trim() || year || source !== "all");
  const readingDraftWaiting = Boolean(initialDraft && consumedReadingDraft.current !== initialDraftKey);

  return <section className="thoughts-panel" aria-labelledby={`${prefix}-heading`}>
    <header className="thoughts-intro">
      <div className="thoughts-heading">
        <p className="section-kicker">留一点空间，给自己的想法</p>
        <h2 id={`${prefix}-heading`}>思考 <span className="thoughts-count">{timeline.length}</span></h2>
        <p>随手写下的想法和博客里的旧文字，在同一条时间线上慢慢回看。</p>
      </div>
      <button ref={newButton} className="button primary" type="button" onClick={() => openEditor()} disabled={Boolean(busy)}><ThoughtIcon name="plus"/>新建思考</button>
    </header>

    {error && <p className="thoughts-alert" role="alert">{error}</p>}
    {status && <p className="thoughts-status" role="status">{status}</p>}
    {readingDraftWaiting && <div className="thoughts-status thoughts-pending-draft" role="status"><p>阅读草稿已准备好。先完成当前编辑，或接收这份草稿。</p><button className="button secondary" type="button" onClick={acceptReadingDraft} disabled={Boolean(busy)}>接收阅读草稿</button></div>}

    {blogStatus}
    {revisit}
    <div className="thoughts-tools thoughts-timeline-tools">
      <div className="thoughts-source-filter" role="group" aria-label="思考来源">{[["all", "全部"], ["local", "随手写"], ["blog", "博客"]].map(([value, label]) => <button key={value} type="button" aria-pressed={source === value} onClick={() => { setSource(value); setPage(1); }}>{label}</button>)}</div>
      <label className="thoughts-search"><ThoughtIcon name="search"/><input type="search" aria-label="搜索思考" placeholder="搜索内容、标题或书名" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/></label>
      <select aria-label="思考年份" value={year} onChange={event => { setYear(event.target.value); setPage(1); }}><option value="">所有年份</option>{years.map(value => <option key={value} value={value}>{value} 年</option>)}</select>
      <span className="thoughts-count">{visibleThoughts.length} 条</span>
    </div>

    <div className={`thoughts-layout${editor ? " thoughts-layout-editing" : ""}`}>
      {editor && draft && <section className="thoughts-editor" aria-labelledby={`${prefix}-editor-heading`}>
        <header className="thoughts-editor-heading"><p className="section-kicker">把一闪而过的想法留下来</p><h3 id={`${prefix}-editor-heading`}>{draft.id ? "编辑这条思考" : "记下当下的想法"}</h3></header>
        <form className="thoughts-form" onSubmit={event => void saveThought(event)} aria-busy={busy?.kind === "save"}>
          <fieldset className="thoughts-fields" disabled={Boolean(busy)}>
            <label className="field" htmlFor={`${prefix}-title`}>思考标题<input ref={titleInput} id={`${prefix}-title`} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} maxLength={200} placeholder="用一句话记住这个想法" required/></label>
            <label className="field" htmlFor={`${prefix}-body`}>我的想法<textarea id={`${prefix}-body`} value={draft.body} onChange={event => updateDraft({ body: event.target.value })} rows={8} maxLength={20_000} placeholder="有什么触动了你？你想继续想清楚什么？" required/></label>
            <details className="thoughts-source-fields" open={Boolean(draft.bookId || draft.sourceExcerpt)}>
              <summary>关联来源与原摘录（可选）</summary>
              <label className="field" htmlFor={`${prefix}-book`}>关联书籍<select id={`${prefix}-book`} value={draft.bookId} disabled={Boolean(draft.highlightId)} onChange={event => updateDraft({ bookId: event.target.value, highlightId: undefined })}><option value="">不关联书籍</option>{selectedBookMissing && <option value={draft.bookId}>原关联书籍（已不在书架）</option>}{library?.books.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
              <label className="field" htmlFor={`${prefix}-excerpt`}>原摘录<textarea id={`${prefix}-excerpt`} value={draft.sourceExcerpt} onChange={event => updateDraft({ sourceExcerpt: event.target.value })} rows={3} maxLength={20_000} readOnly={Boolean(draft.highlightId)} placeholder="保留促成这个想法的那段原话"/>{draft.highlightId && <span>这条思考保留了原划线的来源。</span>}</label>
            </details>
          </fieldset>
          <div className="thoughts-form-actions"><button className="button secondary" type="button" onClick={closeEditor} disabled={Boolean(busy)}>取消</button><button className="button primary" type="submit" disabled={Boolean(busy) || !draft.title.trim() || !draft.body.trim()}>{busy?.kind === "save" ? "正在保存…" : "保存思考"}</button></div>
        </form>
      </section>}

      <div ref={listTop} className="thoughts-list thoughts-list-top" tabIndex={-1} aria-label="思考时间线" aria-busy={Boolean(busy && busy.kind !== "save")}>
        {visibleThoughts.length > 0 && <ThoughtPagination position="顶部" page={currentPage} pages={pageCount} total={visibleThoughts.length} onChange={changePage}/>}
        {pageThoughts.map(item => {
          if (item.blog) return <BlogThoughtCard key={item.id} entry={item.blog} onReflect={() => reflectOnBlog(item.blog!)} disabled={Boolean(busy)}/>;
          const thought = item.local!;
          const book = books.get(thought.bookId ?? "");
          const highlight = highlights.get(thought.highlightId ?? "");
          const linkedHighlight = highlight?.bookId === thought.bookId ? highlight : undefined;
          const excerpt = thought.sourceExcerpt || linkedHighlight?.text;
          const sourceLink = [linkedHighlight?.deepLink, book?.deepLink].find(link => link && isOfficialReadingLink(link));
          const deleting = busy?.kind === "delete" && busy.id === thought.id;
          const converting = busy?.kind === "task" && busy.id === thought.id;
          return <article key={thought.id} id={`thought-${thought.id}`} tabIndex={-1} className="thoughts-card" aria-label={thought.title}>
            <header className="thoughts-card-heading"><div className="thoughts-card-meta"><time dateTime={thought.createdAt}>{dateLabel(thought.createdAt)}</time><span>{book ? `《${book.title}》` : thought.bookId ? "来自阅读" : "随手写"}</span></div><h3>{thought.title}</h3></header>
            <ThoughtText text={thought.body}/>
            {(excerpt || sourceLink) && <details className="thoughts-source"><summary className="thoughts-source-label">{excerpt ? "回看原摘录" : "回看阅读来源"}{book ? ` · ${book.title}` : ""}</summary>{excerpt && <blockquote>{excerpt}</blockquote>}{excerpt && blogReference(excerpt) && <a href={blogReference(excerpt)} target="_blank" rel="noopener noreferrer">打开博客原文<ThoughtIcon name="arrow"/></a>}{sourceLink && <a href={sourceLink} target="_blank" rel="noopener noreferrer">{linkedHighlight?.deepLink === sourceLink ? "打开原划线" : "打开原书"}<ThoughtIcon name="arrow"/></a>}</details>}
            <footer className="thoughts-card-actions"><div><button type="button" aria-label={`编辑思考：${thought.title}`} onClick={() => openEditor(thought)} disabled={Boolean(busy)}>编辑</button><button className="thoughts-danger" type="button" aria-label={`删除思考：${thought.title}`} onClick={() => void deleteThought(thought)} disabled={Boolean(busy)}>{deleting ? "正在删除…" : "删除"}</button></div><details className="reading-transaction-tools thoughts-transaction-tools"><summary>事务工具</summary><p>需要处理一件具体的事时，可以打开待办草稿。</p><button type="button" className="button secondary" aria-label={`转为待办：${thought.title}`} onClick={() => void createTask(thought)} disabled={Boolean(busy)}>{converting ? "正在转入…" : "转为待办"}<ThoughtIcon name="arrow"/></button></details></footer>
          </article>;
        })}
        {pageCount > 1 && <ThoughtPagination position="底部" page={currentPage} pages={pageCount} total={visibleThoughts.length} onChange={changePage}/>}
        {visibleThoughts.length === 0 && <div className="thoughts-empty">
          <span className="thoughts-empty-art"><ThoughtIcon name="note"/></span>
          <h3>{filtered ? "没有找到这条思考" : "给思考留一个位置"}</h3>
          <p>{filtered ? "换一个关键词、来源或年份，再找找看。" : "记下当下的感受、还没想透的问题，或一次观点的变化。"}</p>
          {filtered ? <button className="button secondary" type="button" onClick={() => { setSearch(""); setSource("all"); setYear(""); setPage(1); }}>清除筛选</button> : !editor && <button className="button secondary" type="button" onClick={() => openEditor()} disabled={Boolean(busy)}>写下第一条思考<ThoughtIcon name="plus"/></button>}
          {!filtered && <span className="thoughts-empty-note">不必急着得出答案，先留下此刻的想法。</span>}
        </div>}
      </div>
    </div>
  </section>;
}

function ThoughtPagination({ position, page, pages, total, onChange }: {
  position: string; page: number; pages: number; total: number; onChange: (page: number) => void;
}) {
  const start = (page - 1) * PAGE_SIZE + 1;
  return <nav className="thoughts-pagination" aria-label={`思考分页（${position}）`}>
    <span className="thoughts-page-summary" aria-live="polite">第 {start}–{Math.min(start + PAGE_SIZE - 1, total)} 条 · 共 {total} 条</span>
    <div className="thoughts-page-controls">
      <button className="button secondary" type="button" onClick={() => onChange(page - 1)} disabled={page === 1}>上一页</button>
      <label className="thoughts-page-picker"><select aria-label={`思考页码（${position}）`} value={page} onChange={event => onChange(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index + 1} value={index + 1}>第 {index + 1} 页</option>)}</select><span>/ {pages}</span></label>
      <button className="button secondary" type="button" onClick={() => onChange(page + 1)} disabled={page === pages}>下一页</button>
    </div>
  </nav>;
}

function publicLink(value: string): string | undefined {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function blogReference(excerpt: string): string | undefined {
  const match = excerpt.match(/原文：(https:\/\/www\.ashsilent\.com\/\S+)/);
  return match ? publicLink(match[1]) : undefined;
}
function ThoughtText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const characters = Array.from(text);
  const long = characters.length > 360;
  return <><p className="thoughts-body">{expanded || !long ? text : `${characters.slice(0, 360).join("")}…`}</p>{long && <button className="text-button thoughts-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起全文" : "展开全文"}</button>}</>;
}
function BlogImage({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const link = publicLink(url);
  if (!link) return null;
  return <figure className="thoughts-blog-image">{failed ? <p>图片暂时无法加载</p> : <img src={link} alt={alt || "博客原图"} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>}<figcaption><a href={link} target="_blank" rel="noopener noreferrer">查看原图</a></figcaption></figure>;
}
function BlogThoughtCard({ entry, onReflect, disabled }: { entry: BlogEntry; onReflect: () => void; disabled: boolean }) {
  const source = publicLink(entry.sourceUrl);
  const links = [...new Set([...entry.links, ...entry.media.map(item => item.url)])].filter(url => publicLink(url) && url !== source);
  return <article id={`thought-${entry.id}`} tabIndex={-1} className="thoughts-card thoughts-blog-card" aria-label={entry.title || "博客记录"}>
    <header className="thoughts-card-heading"><div className="thoughts-card-meta"><time dateTime={entry.date}>{dateLabel(entry.date)}</time><span>博客 · {entry.author || "AshSilent"}</span></div>{entry.title.trim() && <h3>{entry.title}</h3>}</header>
    {entry.text && <ThoughtText text={entry.text}/>}
    {entry.images.length > 0 && <div className="thoughts-blog-images">{entry.images.map((image, index) => <BlogImage key={`${image.url}:${index}`} {...image}/>)}</div>}
    {links.length > 0 && <details className="thoughts-source"><summary>原文中的链接与媒体（{links.length}）</summary><p>音频、视频和嵌入内容可在原页面打开。</p><ul>{links.map((link, index) => <li key={link}><a href={publicLink(link)} target="_blank" rel="noopener noreferrer">{entry.media.find(item => item.url === link)?.title || `打开链接 ${index + 1}`}</a></li>)}</ul></details>}
    {!entry.text && !entry.images.length && <p className="thoughts-body">这条记录包含媒体或链接，可打开原文查看。</p>}
    <footer className="thoughts-card-actions"><div>{source && <a href={source} target="_blank" rel="noopener noreferrer">原文 ↗</a>}<button type="button" onClick={onReflect} disabled={disabled}>写下此刻的感受</button></div></footer>
  </article>;
}
