"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { LifeThought } from "@/lib/life";
import { isSafeReadingLink, type ReadingLibrary } from "@/lib/reading";
import type { Area } from "@/lib/types";
import "./reading.css";

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

export default function ThoughtsPanel({ thoughts, onThoughtsChange, onCreateTask, library, initialDraft, onDraftConsumed }: ThoughtsPanelProps) {
  const prefix = useId();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const wasEditorOpen = useRef(false);
  const consumedReadingDraft = useRef<string | null>(null);
  const working = useRef(false);

  const books = useMemo(() => new Map(library?.books.map(book => [book.id, book]) ?? []), [library?.books]);
  const highlights = useMemo(() => new Map(library?.highlights.map(highlight => [highlight.id, highlight]) ?? []), [library?.highlights]);
  const initialDraftKey = useMemo(() => initialDraft ? sourceDraftKey(initialDraft) : null, [initialDraft]);
  const visibleThoughts = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return thoughts.filter(thought => !query || [thought.title, thought.body, thought.sourceExcerpt ?? "", books.get(thought.bookId ?? "")?.title ?? ""]
      .some(text => text.toLocaleLowerCase().includes(query)))
      .slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [thoughts, search, books]);

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
      setSearch("");
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
  const readingDraftWaiting = Boolean(initialDraft && consumedReadingDraft.current !== initialDraftKey);

  return <section className="thoughts-panel" aria-labelledby={`${prefix}-heading`}>
    <header className="thoughts-intro">
      <div className="thoughts-heading">
        <p className="section-kicker">留一点空间，给自己的想法</p>
        <h2 id={`${prefix}-heading`}>思考笔记 <span className="thoughts-count">{thoughts.length}</span></h2>
        <p>读到的、想到的，都可以在这里慢慢写清楚。</p>
      </div>
      <button ref={newButton} className="button primary" type="button" onClick={() => openEditor()} disabled={Boolean(busy)}><ThoughtIcon name="plus"/>新建思考</button>
    </header>

    {error && <p className="thoughts-alert" role="alert">{error}</p>}
    {status && <p className="thoughts-status" role="status">{status}</p>}
    {readingDraftWaiting && <div className="thoughts-status thoughts-pending-draft" role="status"><p>阅读草稿已准备好。先完成当前编辑，或接收这份草稿。</p><button className="button secondary" type="button" onClick={acceptReadingDraft} disabled={Boolean(busy)}>接收阅读草稿</button></div>}

    {thoughts.length > 0 && <div className="thoughts-tools">
      <label className="thoughts-search"><ThoughtIcon name="search"/><input type="search" aria-label="搜索思考" placeholder="搜索标题、想法或书名" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <span className="thoughts-count">{search.trim() ? `${visibleThoughts.length} 条结果` : `共 ${thoughts.length} 条`}</span>
    </div>}

    <div className={`thoughts-layout${editor ? " thoughts-layout-editing" : ""}`}>
      {editor && draft && <section className="thoughts-editor" aria-labelledby={`${prefix}-editor-heading`}>
        <header className="thoughts-editor-heading"><p className="section-kicker">把一闪而过的想法留下来</p><h3 id={`${prefix}-editor-heading`}>{draft.id ? "编辑这条思考" : "记下当下的想法"}</h3></header>
        <form className="thoughts-form" onSubmit={event => void saveThought(event)} aria-busy={busy?.kind === "save"}>
          <fieldset className="thoughts-fields" disabled={Boolean(busy)}>
            <label className="field" htmlFor={`${prefix}-title`}>思考标题<input ref={titleInput} id={`${prefix}-title`} value={draft.title} onChange={event => updateDraft({ title: event.target.value })} maxLength={200} placeholder="用一句话记住这个想法" required/></label>
            <label className="field" htmlFor={`${prefix}-body`}>我的想法<textarea id={`${prefix}-body`} value={draft.body} onChange={event => updateDraft({ body: event.target.value })} rows={8} maxLength={20_000} placeholder="有什么触动了你？你想继续想清楚什么？" required/></label>
            <details className="thoughts-source-fields" open={Boolean(draft.bookId || draft.sourceExcerpt)}>
              <summary>关联书籍与原摘录（可选）</summary>
              <label className="field" htmlFor={`${prefix}-book`}>关联书籍<select id={`${prefix}-book`} value={draft.bookId} disabled={Boolean(draft.highlightId)} onChange={event => updateDraft({ bookId: event.target.value, highlightId: undefined })}><option value="">不关联书籍</option>{selectedBookMissing && <option value={draft.bookId}>原关联书籍（已不在书架）</option>}{library?.books.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
              <label className="field" htmlFor={`${prefix}-excerpt`}>原摘录<textarea id={`${prefix}-excerpt`} value={draft.sourceExcerpt} onChange={event => updateDraft({ sourceExcerpt: event.target.value })} rows={3} maxLength={20_000} readOnly={Boolean(draft.highlightId)} placeholder="保留促成这个想法的那段原话"/>{draft.highlightId && <span>这条思考保留了原划线的来源。</span>}</label>
            </details>
          </fieldset>
          <div className="thoughts-form-actions"><button className="button secondary" type="button" onClick={closeEditor} disabled={Boolean(busy)}>取消</button><button className="button primary" type="submit" disabled={Boolean(busy) || !draft.title.trim() || !draft.body.trim()}>{busy?.kind === "save" ? "正在保存…" : "保存思考"}</button></div>
        </form>
      </section>}

      <div className="thoughts-list" aria-busy={Boolean(busy && busy.kind !== "save")}>
        {visibleThoughts.map(thought => {
          const book = books.get(thought.bookId ?? "");
          const highlight = highlights.get(thought.highlightId ?? "");
          const linkedHighlight = highlight?.bookId === thought.bookId ? highlight : undefined;
          const excerpt = thought.sourceExcerpt || linkedHighlight?.text;
          const sourceLink = [linkedHighlight?.deepLink, book?.deepLink].find(link => link && isOfficialReadingLink(link));
          const deleting = busy?.kind === "delete" && busy.id === thought.id;
          const converting = busy?.kind === "task" && busy.id === thought.id;
          return <article key={thought.id} className="thoughts-card" aria-label={thought.title}>
            <header className="thoughts-card-heading"><h3>{thought.title}</h3><div className="thoughts-card-meta"><time dateTime={thought.updatedAt}>{dateLabel(thought.updatedAt)}</time><span>{book ? `《${book.title}》` : thought.bookId ? "来自阅读" : "随手思考"}</span></div></header>
            <p className="thoughts-body">{thought.body}</p>
            {(excerpt || sourceLink) && <details className="thoughts-source"><summary className="thoughts-source-label">{excerpt ? "回看原摘录" : "回看阅读来源"}{book ? ` · ${book.title}` : ""}</summary>{excerpt && <blockquote>{excerpt}</blockquote>}{sourceLink && <a href={sourceLink} target="_blank" rel="noopener noreferrer">{linkedHighlight?.deepLink === sourceLink ? "打开原划线" : "打开原书"}<ThoughtIcon name="arrow"/></a>}</details>}
            <footer className="thoughts-card-actions"><button type="button" aria-label={`转为待办：${thought.title}`} onClick={() => void createTask(thought)} disabled={Boolean(busy)}>{converting ? "正在转入…" : "转为待办"}<ThoughtIcon name="arrow"/></button><div><button type="button" aria-label={`编辑思考：${thought.title}`} onClick={() => openEditor(thought)} disabled={Boolean(busy)}>编辑</button><button className="thoughts-danger" type="button" aria-label={`删除思考：${thought.title}`} onClick={() => void deleteThought(thought)} disabled={Boolean(busy)}>{deleting ? "正在删除…" : "删除"}</button></div></footer>
          </article>;
        })}
        {visibleThoughts.length === 0 && <div className="thoughts-empty">
          <span className="thoughts-empty-art"><ThoughtIcon name="note"/></span>
          <h3>{search.trim() ? "没有找到这条思考" : "给思考留一个位置"}</h3>
          <p>{search.trim() ? "换一个关键词，再找找看。" : "记下一段阅读后的感受，或一个还没想透的问题。"}</p>
          {search.trim() ? <button className="button secondary" type="button" onClick={() => setSearch("")}>清除搜索</button> : !editor && <button className="button secondary" type="button" onClick={() => openEditor()} disabled={Boolean(busy)}>写下第一条思考<ThoughtIcon name="plus"/></button>}
          {!search.trim() && <span className="thoughts-empty-note">不必急着得出答案，先留下此刻的想法。</span>}
        </div>}
      </div>
    </div>
  </section>;
}
