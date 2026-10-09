"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AREAS, type Area } from "@/lib/types";
import { chinaToday } from "@/lib/dates";
import { lifeBoardSchema, type LifeBoardData, type LifeObservation, type LifeReview, type LifeThread, type LifeThought } from "@/lib/life";
import type { ReadingLibrary } from "@/lib/reading";
import type { MediaLibrary } from "@/lib/media";
import { mediaWorkCount } from "@/lib/media-view";
import "./life-board.css";

export interface LifeBoardProps {
  board: LifeBoardData;
  reading: ReadingLibrary;
  media: MediaLibrary;
  thoughts: LifeThought[];
  thoughtCount?: number;
  today: string;
  onBoardChange: (next: LifeBoardData) => Promise<void>;
  onOpenReading: () => void;
  onOpenMedia: () => void;
  onOpenThoughts: () => void;
  revisit?: ReactNode;
}

const THREAD_KINDS: Record<LifeThread["kind"], string> = { interest: "兴趣", concern: "牵挂", question: "疑问", direction: "方向" };
const THREAD_STATES: Record<LifeThread["state"], string> = { active: "正在关注", resting: "暂时放下", archived: "已归档" };
const OBSERVATION_KINDS: Record<LifeObservation["kind"], string> = { experience: "经历", feeling: "感受", discovery: "发现" };
const REVIEW_PROMPTS: { key: "noticed" | "changed" | "keep"; title: string; placeholder: string }[] = [
  { key: "noticed", title: "我注意到了什么？", placeholder: "这段时间，有什么反复出现、触动了你，或值得再看一眼？" },
  { key: "changed", title: "什么正在变化？", placeholder: "感受、关系、习惯、想法……有哪些细微的变化？" },
  { key: "keep", title: "我愿意继续保留什么？", placeholder: "哪些人、事、感受或做法，是你想留在生活里的？" },
];

type ObservationDraft = Omit<LifeObservation, "threadId"> & { threadId: string };
type BoardDialog =
  | { kind: "thread"; draft: LifeThread; initial: string; original?: LifeThread }
  | { kind: "observation"; draft: ObservationDraft; initial: string; original?: LifeObservation }
  | { kind: "review"; draft: LifeReview; initial: string; original?: LifeReview };
type TimelineEntry = { kind: "observation"; item: LifeObservation } | { kind: "review"; item: LifeReview };

function BoardIcon({ name, size = 20 }: { name: "leaf" | "plus" | "close" | "note" | "book" | "arrow" | "circle"; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    leaf: <><path d="M5 18C-1 6 13 2 21 3c0 9-3 18-13 17M4 22 17 8"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    note: <><path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h6"/></>,
    book: <><path d="M12 5C8 3 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-1-10 1Z"/><path d="M12 5v15"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>, circle: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function dateLabel(date: string): string {
  const value = new Date(`${date}T12:00:00+08:00`);
  return Number.isNaN(value.getTime()) ? date : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(value);
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some(item => item.id === next.id) ? items.map(item => item.id === next.id ? next : item) : [...items, next];
}

function BoardModal({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const initialInput = ref.current?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled)");
    (initialInput ?? ref.current)?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? []);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      const focusIsOutside = !ref.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current || focusIsOutside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current || focusIsOutside)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="life-board-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="life-board-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="life-board-dialog-title" tabIndex={-1}>
      <header className="life-board-dialog-header"><div><p>留在生活里的文字</p><h2 id="life-board-dialog-title">{title}</h2></div><button type="button" className="life-board-icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><BoardIcon name="close"/></button></header>
      {children}
    </div>
  </div>;
}

export default function LifeBoard({ board, reading, media, thoughts, today, onBoardChange, onOpenReading, onOpenMedia, onOpenThoughts, revisit, thoughtCount = thoughts.length }: LifeBoardProps) {
  const [areaFilter, setAreaFilter] = useState<Area | "all">("all");
  const [stateFilter, setStateFilter] = useState<LifeThread["state"] | "all">("all");
  const [timelineFilter, setTimelineFilter] = useState<LifeObservation["kind"] | "review" | "all">("all");
  const [timelineLimit, setTimelineLimit] = useState(20);
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const working = useRef(false);
  const threads = useMemo(() => new Map(board.threads.map(thread => [thread.id, thread])), [board.threads]);
  const areaCounts = useMemo(() => {
    const counts = new Map<Area, number>();
    for (const thread of board.threads) counts.set(thread.area, (counts.get(thread.area) ?? 0) + 1);
    return counts;
  }, [board.threads]);
  const visibleThreads = board.threads.filter(thread => areaFilter === "all" || thread.area === areaFilter).filter(thread => stateFilter === "all" || thread.state === stateFilter)
    .slice().sort((a, b) => ({ active: 0, resting: 1, archived: 2 }[a.state] - { active: 0, resting: 1, archived: 2 }[b.state]) || b.updatedAt.localeCompare(a.updatedAt));
  const timeline = useMemo<TimelineEntry[]>(() => [
    ...board.observations.map(item => ({ kind: "observation" as const, item })),
    ...board.reviews.map(item => ({ kind: "review" as const, item })),
  ].sort((a, b) => b.item.date.localeCompare(a.item.date) || b.item.createdAt.localeCompare(a.item.createdAt)), [board.observations, board.reviews]);
  const filteredTimeline = timeline.filter(entry => timelineFilter === "all" || (entry.kind === "review" ? timelineFilter === "review" : entry.item.kind === timelineFilter));

  function openThread(thread?: LifeThread) {
    if (working.current) return;
    const now = new Date().toISOString();
    const draft: LifeThread = thread ? { ...thread } : { id: crypto.randomUUID(), title: "", description: "", area: "生活", kind: "interest", state: "active", createdAt: now, updatedAt: now };
    setDialog({ kind: "thread", draft, initial: JSON.stringify(draft), original: thread }); setFormError("");
  }
  function openObservation(thread?: LifeThread, observation?: LifeObservation) {
    if (working.current) return;
    const draft: ObservationDraft = observation ? { ...observation, threadId: observation.threadId ?? "" } : { id: crypto.randomUUID(), threadId: thread?.id ?? "", area: thread?.area ?? "生活", kind: "experience", text: "", date: today || chinaToday(), createdAt: new Date().toISOString() };
    setDialog({ kind: "observation", draft, initial: JSON.stringify(draft), original: observation }); setFormError("");
  }
  function openReview(review?: LifeReview) {
    if (working.current) return;
    const draft: LifeReview = review ? { ...review } : { id: crypto.randomUUID(), title: "", date: today || chinaToday(), noticed: "", changed: "", keep: "", createdAt: new Date().toISOString() };
    setDialog({ kind: "review", draft, initial: JSON.stringify(draft), original: review }); setFormError("");
  }
  function closeDialog() {
    if (working.current) return;
    if (dialog && JSON.stringify(dialog.draft) !== dialog.initial && !window.confirm("还有未保存的文字。放弃这份草稿吗？")) return;
    setDialog(null); setFormError("");
  }
  function updateThread(next: Partial<LifeThread>) { setDialog(previous => previous?.kind === "thread" ? { ...previous, draft: { ...previous.draft, ...next } } : previous); }
  function updateObservation(next: Partial<ObservationDraft>) { setDialog(previous => previous?.kind === "observation" ? { ...previous, draft: { ...previous.draft, ...next } } : previous); }
  function updateReview(next: Partial<LifeReview>) { setDialog(previous => previous?.kind === "review" ? { ...previous, draft: { ...previous.draft, ...next } } : previous); }
  function errorMessage(cause: unknown, fallback: string) { return cause instanceof Error && cause.message ? cause.message : fallback; }
  async function persist(next: LifeBoardData) {
    const valid = lifeBoardSchema.safeParse(next);
    if (!valid.success) throw new Error("请检查日期、文字长度与必填内容，再试一次。");
    await onBoardChange(valid.data);
  }

  async function saveDialog(event: FormEvent) {
    event.preventDefault(); if (!dialog || working.current) return;
    if (dialog.kind === "thread" && !dialog.draft.title.trim()) { setFormError("请给这条线索一个名字。"); return; }
    if (dialog.kind === "observation" && !dialog.draft.text.trim()) { setFormError("请留下这次经历、感受或发现。"); return; }
    if (dialog.kind === "review" && (!dialog.draft.title.trim() || !REVIEW_PROMPTS.some(prompt => dialog.draft[prompt.key].trim()))) { setFormError("请填写回顾标题，并至少写下一项发现、变化或想保留的事。"); return; }
    working.current = true; setBusy("save"); setFormError("");
    try {
      let next: LifeBoardData;
      if (dialog.kind === "thread") {
        const current = board.threads.find(item => item.id === dialog.draft.id);
        if (dialog.original && JSON.stringify(current) !== JSON.stringify(dialog.original)) throw new Error("这条线索已经变化，请复制草稿后重新打开，以免覆盖新内容。");
        const saved = { ...dialog.draft, title: dialog.draft.title.trim(), updatedAt: new Date().toISOString() };
        next = { ...board, threads: upsert(board.threads, saved) };
      } else if (dialog.kind === "observation") {
        const current = board.observations.find(item => item.id === dialog.draft.id);
        if (dialog.original && JSON.stringify(current) !== JSON.stringify(dialog.original)) throw new Error("这段记录已经变化，请复制草稿后重新打开，以免覆盖新内容。");
        const { threadId, ...rest } = dialog.draft;
        const saved: LifeObservation = { ...rest, ...(threadId ? { threadId } : {}) };
        next = { ...board, observations: upsert(board.observations, saved) };
      } else {
        const current = board.reviews.find(item => item.id === dialog.draft.id);
        if (dialog.original && JSON.stringify(current) !== JSON.stringify(dialog.original)) throw new Error("这次回顾已经变化，请复制草稿后重新打开，以免覆盖新内容。");
        next = { ...board, reviews: upsert(board.reviews, { ...dialog.draft, title: dialog.draft.title.trim() }) };
      }
      await persist(next);
      setMessage(dialog.kind === "thread" ? "线索已保存在人生看板。" : dialog.kind === "observation" ? "这段记录已经留下。" : "这次回顾已经留下。");
      if (dialog.kind === "thread") { setAreaFilter("all"); setStateFilter("all"); }
      else { setTimelineFilter("all"); setTimelineLimit(20); }
      setDialog(null); setError("");
    } catch (cause) { setFormError(`${errorMessage(cause, "保存失败，请重试。")} 草稿仍保留在这里。`); }
    finally { working.current = false; setBusy(null); }
  }

  async function changeThreadState(thread: LifeThread, state: LifeThread["state"]) {
    if (working.current || thread.state === state) return;
    working.current = true; setBusy(thread.id); setError("");
    try { await persist({ ...board, threads: board.threads.map(item => item.id === thread.id ? { ...item, state, updatedAt: new Date().toISOString() } : item) }); setMessage(`「${thread.title}」${state === "active" ? "已重新放回关注中" : state === "resting" ? "已暂时放下" : "已归档"}。`); }
    catch (cause) { setError(errorMessage(cause, "线索更新失败，请重试。")); }
    finally { working.current = false; setBusy(null); }
  }

  async function deleteThread(thread: LifeThread) {
    if (working.current || !window.confirm(`删除线索「${thread.title}」？关联的经历、感受和发现会保留，删除的线索无法恢复。`)) return;
    working.current = true; setBusy(thread.id); setError("");
    try { await persist({ ...board, threads: board.threads.filter(item => item.id !== thread.id) }); setMessage("线索已移除，关联的经历、感受与发现仍然保留。"); }
    catch (cause) { setError(errorMessage(cause, "删除失败，请重试。")); }
    finally { working.current = false; setBusy(null); }
  }

  async function deleteTimelineEntry(entry: TimelineEntry) {
    if (working.current || !window.confirm(`删除${entry.kind === "review" ? `回顾「${entry.item.title}」` : `这段${OBSERVATION_KINDS[entry.item.kind]}`}？删除后无法恢复。`)) return;
    working.current = true; setBusy(entry.item.id); setError("");
    try { await persist(entry.kind === "review" ? { ...board, reviews: board.reviews.filter(item => item.id !== entry.item.id) } : { ...board, observations: board.observations.filter(item => item.id !== entry.item.id) }); setMessage("这段记录已删除。"); }
    catch (cause) { setError(errorMessage(cause, "删除失败，请重试。")); }
    finally { working.current = false; setBusy(null); }
  }

  return <section className="life-board" aria-labelledby="life-board-title">
    <header className="life-board-intro"><div><p>YOUR LIFE, IN VIEW</p><h1 id="life-board-title">人生看板</h1><p>看见此刻的生活，也看见慢慢变化的自己。</p></div><div className="life-board-intro-actions"><button type="button" className="button secondary" onClick={() => openReview()} disabled={Boolean(busy)}><BoardIcon name="circle" size={17}/>写一次回顾</button><button type="button" className="button primary" onClick={() => openObservation()} disabled={Boolean(busy)}><BoardIcon name="plus" size={18}/>留下一段记录</button></div></header>
    {revisit}
    <div className="life-board-overview" aria-label="看板中的真实留痕"><span><strong>{board.threads.length}</strong> 条生活线索</span><span><strong>{board.observations.length}</strong> 段经历、感受与发现</span><span><strong>{board.reviews.length}</strong> 次回顾</span></div>
    <div className="life-board-feedback" aria-live="polite">{message && <p className="life-board-success">{message}<button type="button" className="life-board-icon-button" onClick={() => setMessage("")} aria-label="关闭提示"><BoardIcon name="close" size={16}/></button></p>}</div>
    {error && <p className="life-board-error" role="alert">{error}<button type="button" className="life-board-icon-button" onClick={() => setError("")} aria-label="关闭错误提示"><BoardIcon name="close" size={16}/></button></p>}
    <div className="life-board-layout">
      <section className="life-thread-section" aria-labelledby="life-threads-title"><header className="life-board-section-heading"><div><p>此刻，心里放着的事</p><h2 id="life-threads-title">关注的线索</h2></div><button type="button" className="button secondary" onClick={() => openThread()} disabled={Boolean(busy)}><BoardIcon name="plus" size={16}/>新增线索</button></header>
        <div className="life-board-domains" role="group" aria-label="按生活领域查看线索">
          <button type="button" aria-pressed={areaFilter === "all"} onClick={() => setAreaFilter("all")}><span>全部</span><span className="life-domain-count">{board.threads.length}</span></button>
          {AREAS.map(area => <button key={area} type="button" aria-pressed={areaFilter === area} onClick={() => setAreaFilter(area)}><span>{area}</span><span className="life-domain-count">{areaCounts.get(area) ?? 0}</span></button>)}
        </div>
        <div className="life-board-filters"><label htmlFor="life-thread-area">生活领域<select id="life-thread-area" value={areaFilter} onChange={event => setAreaFilter(event.target.value as typeof areaFilter)}><option value="all">全部领域</option>{AREAS.map(area => <option key={area}>{area}</option>)}</select></label><label htmlFor="life-thread-state">线索状态<select id="life-thread-state" value={stateFilter} onChange={event => setStateFilter(event.target.value as typeof stateFilter)}><option value="all">全部状态</option>{Object.entries(THREAD_STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
        {visibleThreads.length ? <div className="life-thread-grid">{visibleThreads.map(thread => <article key={thread.id} className={`life-thread-card life-thread-state-${thread.state}`}><header className="life-thread-card-heading"><div className="life-thread-tags"><span className={`life-kind life-kind-${thread.kind}`}>{THREAD_KINDS[thread.kind]}</span><span className="life-area">{thread.area}</span></div><h3>{thread.title}</h3></header>{thread.description && <p className="life-thread-description">{thread.description}</p>}<p className="life-state">{THREAD_STATES[thread.state]}</p><div className="life-thread-actions"><button type="button" onClick={() => openObservation(thread)} disabled={Boolean(busy)} aria-label={`为线索留下记录：${thread.title}`}>留下记录<BoardIcon name="plus" size={14}/></button><button type="button" onClick={() => openThread(thread)} disabled={Boolean(busy)} aria-label={`编辑线索：${thread.title}`}>编辑</button>{thread.state === "active" ? <button type="button" onClick={() => void changeThreadState(thread, "resting")} disabled={Boolean(busy)} aria-label={`暂时放下：${thread.title}`}>暂时放下</button> : <button type="button" onClick={() => void changeThreadState(thread, "active")} disabled={Boolean(busy)} aria-label={`重新关注：${thread.title}`}>重新关注</button>}{thread.state !== "archived" && <button type="button" onClick={() => void changeThreadState(thread, "archived")} disabled={Boolean(busy)} aria-label={`归档线索：${thread.title}`}>归档</button>}<button type="button" className="life-board-danger" onClick={() => void deleteThread(thread)} disabled={Boolean(busy)} aria-label={`删除线索：${thread.title}`}>删除</button></div></article>)}</div> : <div className="life-board-empty"><span><BoardIcon name="leaf" size={36}/></span><h3>{board.threads.length ? "这里暂时没有匹配的线索" : "让生活的线索，慢慢显出轮廓"}</h3><p>{board.threads.length ? "可以换一个领域或状态，再看看。" : "一个一直想探索的兴趣、一份牵挂、一个疑问，或一个正在靠近的方向，都可以留在这里。"}</p><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={board.threads.length ? () => { setAreaFilter("all"); setStateFilter("all"); } : () => openThread()}>{board.threads.length ? "查看全部线索" : "留下第一条线索"}</button></div>}
      </section>
      <aside className="life-board-aside" aria-label="生活里的独立空间"><section className="life-board-aside-card"><BoardIcon name="leaf" size={28}/><h2>给变化一点时间。</h2><p>正在关心的事情，和真实留下的记录，会慢慢显出生活的轮廓。</p><p>线索可以生长，也可以暂时安静一阵。</p></section><button type="button" className="life-board-entry-card" onClick={onOpenReading}><BoardIcon name="book" size={23}/><span><strong>我的阅读</strong><small>{reading.books.length} 本书 · 书籍、划线与阅读记录</small></span><BoardIcon name="arrow" size={17}/></button><button type="button" className="life-board-entry-card" onClick={onOpenMedia}><BoardIcon name="circle" size={23}/><span><strong>我的影音</strong><small>{mediaWorkCount(media.entries)} 部作品 · 观看记录与自己的感受</small></span><BoardIcon name="arrow" size={17}/></button><button type="button" className="life-board-entry-card" onClick={onOpenThoughts}><BoardIcon name="note" size={23}/><span><strong>自己的思考</strong><small>{thoughtCount} 条思考 · 博客与随手写的感悟</small></span><BoardIcon name="arrow" size={17}/></button></aside>
    </div>
    <section className="life-timeline-section" aria-labelledby="life-timeline-title"><header className="life-board-section-heading"><div><p>经历、感受、发现与回顾</p><h2 id="life-timeline-title">生活留痕</h2></div><button type="button" className="button secondary" onClick={() => openObservation()} disabled={Boolean(busy)}><BoardIcon name="plus" size={16}/>留下一段记录</button></header><div className="life-timeline-tools"><label htmlFor="life-timeline-kind">查看记录<select id="life-timeline-kind" value={timelineFilter} onChange={event => { setTimelineFilter(event.target.value as typeof timelineFilter); setTimelineLimit(20); }}><option value="all">全部留痕</option>{Object.entries(OBSERVATION_KINDS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}<option value="review">回顾</option></select></label><span>{filteredTimeline.length} 条记录</span></div>
      {filteredTimeline.length ? <><ol className="life-timeline">{filteredTimeline.slice(0, timelineLimit).map(entry => <li key={entry.item.id} className={`life-timeline-item life-timeline-${entry.kind}`}><time className="life-timeline-date" dateTime={entry.item.date}>{dateLabel(entry.item.date)}</time><article className="life-timeline-content">{entry.kind === "observation" ? <><div className="life-timeline-meta"><span className="life-kind">{OBSERVATION_KINDS[entry.item.kind]}</span><span className="life-area">{entry.item.area}</span>{entry.item.threadId && <span>{threads.get(entry.item.threadId)?.title || "原线索已移除"}</span>}</div><p>{entry.item.text}</p></> : <><div className="life-timeline-meta"><span className="life-kind">回顾</span></div><h3>{entry.item.title}</h3><dl className="life-review-prompts">{REVIEW_PROMPTS.filter(prompt => entry.item[prompt.key].trim()).map(prompt => <div key={prompt.key}><dt>{prompt.title}</dt><dd>{entry.item[prompt.key]}</dd></div>)}</dl></>}<div className="life-timeline-actions"><button type="button" disabled={Boolean(busy)} aria-label={entry.kind === "review" ? `编辑回顾：${entry.item.title}` : `编辑${OBSERVATION_KINDS[entry.item.kind]}：${entry.item.date}`} onClick={() => entry.kind === "review" ? openReview(entry.item) : openObservation(undefined, entry.item)}>编辑</button><button type="button" className="life-board-danger" disabled={Boolean(busy)} aria-label={entry.kind === "review" ? `删除回顾：${entry.item.title}` : `删除${OBSERVATION_KINDS[entry.item.kind]}：${entry.item.date}`} onClick={() => void deleteTimelineEntry(entry)}>删除</button></div></article></li>)}</ol>{filteredTimeline.length > timelineLimit && <button type="button" className="button secondary life-timeline-more" onClick={() => setTimelineLimit(previous => previous + 20)}>再看看更早的记录</button>}</> : <div className="life-board-empty"><span><BoardIcon name="note" size={34}/></span><h3>{timeline.length ? "这类记录，还没有留下" : "给真实发生过的事，留一个位置"}</h3><p>一段经历、一种感受、一个发现，或者一次回顾，都能成为以后回看的线索。</p><button type="button" className="button secondary" onClick={() => openObservation()} disabled={Boolean(busy)}>留下一段经历、感受或发现</button></div>}
    </section>
    {dialog && <BoardModal title={dialog.kind === "thread" ? dialog.original ? "再看看这条线索" : "留下一个正在关心的线索" : dialog.kind === "observation" ? dialog.original ? "再看看这段记录" : "留下一段经历、感受或发现" : dialog.original ? "再看看这次回顾" : "写一次回顾"} busy={Boolean(busy)} onClose={closeDialog}><form onSubmit={event => void saveDialog(event)}><div className="life-board-dialog-body"><fieldset className="life-board-form-grid" disabled={Boolean(busy)}>
      {dialog.kind === "thread" && <><label className="life-board-field life-board-field-full" htmlFor="life-thread-title">线索的名字<input id="life-thread-title" required maxLength={200} value={dialog.draft.title} onChange={event => updateThread({ title: event.target.value })} placeholder="例如：想更了解自己的阅读兴趣"/></label><label className="life-board-field" htmlFor="life-thread-kind">这是一条怎样的线索？<select id="life-thread-kind" value={dialog.draft.kind} onChange={event => updateThread({ kind: event.target.value as LifeThread["kind"] })}>{Object.entries(THREAD_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="life-board-field" htmlFor="life-thread-form-area">生活领域<select id="life-thread-form-area" value={dialog.draft.area} onChange={event => updateThread({ area: event.target.value as Area })}>{AREAS.map(area => <option key={area}>{area}</option>)}</select></label><label className="life-board-field life-board-field-full" htmlFor="life-thread-description">想留给它的话<span>可留空，也可以写下它为什么让你在意。</span><textarea id="life-thread-description" rows={4} maxLength={5000} value={dialog.draft.description} onChange={event => updateThread({ description: event.target.value })} placeholder="它与你的生活有什么联系？"/></label><label className="life-board-field life-board-field-full" htmlFor="life-thread-form-state">此刻的状态<select id="life-thread-form-state" value={dialog.draft.state} onChange={event => updateThread({ state: event.target.value as LifeThread["state"] })}>{Object.entries(THREAD_STATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></>}
      {dialog.kind === "observation" && <><label className="life-board-field" htmlFor="life-observation-kind">记录的是什么？<select id="life-observation-kind" value={dialog.draft.kind} onChange={event => updateObservation({ kind: event.target.value as LifeObservation["kind"] })}>{Object.entries(OBSERVATION_KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="life-board-field" htmlFor="life-observation-date">发生的日期<input id="life-observation-date" type="date" required value={dialog.draft.date} onChange={event => updateObservation({ date: event.target.value })}/></label><label className="life-board-field life-board-field-full" htmlFor="life-observation-text">留下这段经历、感受或发现<textarea id="life-observation-text" rows={6} required maxLength={5000} value={dialog.draft.text} onChange={event => updateObservation({ text: event.target.value })} placeholder="发生了什么？你当时有什么感受，又注意到了什么？"/></label><label className="life-board-field" htmlFor="life-observation-area">生活领域<select id="life-observation-area" value={dialog.draft.area} onChange={event => updateObservation({ area: event.target.value as Area })}>{AREAS.map(area => <option key={area}>{area}</option>)}</select></label><label className="life-board-field" htmlFor="life-observation-thread">关联线索（可选）<select id="life-observation-thread" value={dialog.draft.threadId} onChange={event => { const thread = threads.get(event.target.value); updateObservation({ threadId: event.target.value, ...(thread ? { area: thread.area } : {}) }); }}><option value="">不关联线索</option>{dialog.draft.threadId && !threads.has(dialog.draft.threadId) && <option value={dialog.draft.threadId}>原线索已移除</option>}{board.threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}</select></label></>}
      {dialog.kind === "review" && <><label className="life-board-field life-board-field-full" htmlFor="life-review-title">这次回顾的名字<input id="life-review-title" required maxLength={200} value={dialog.draft.title} onChange={event => updateReview({ title: event.target.value })} placeholder="例如：最近这一周"/></label><label className="life-board-field life-board-field-full" htmlFor="life-review-date">回顾日期<input id="life-review-date" required type="date" value={dialog.draft.date} onChange={event => updateReview({ date: event.target.value })}/></label><p className="life-board-field-full life-board-form-note">三问中，写下此刻有回应的那一问就好。</p>{REVIEW_PROMPTS.map(prompt => <label key={prompt.key} className="life-board-field life-board-field-full" htmlFor={`life-review-${prompt.key}`}>{prompt.title}<textarea id={`life-review-${prompt.key}`} rows={3} maxLength={5000} value={dialog.draft[prompt.key]} placeholder={prompt.placeholder} onChange={event => updateReview({ [prompt.key]: event.target.value })}/></label>)}</>}
    </fieldset>{formError && <p className="life-board-error" role="alert">{formError}</p>}</div><footer className="life-board-dialog-footer"><span>保存后，可以在看板里继续回看。</span><div><button type="button" className="button secondary" onClick={closeDialog} disabled={Boolean(busy)}>取消</button><button type="submit" className="button primary" disabled={Boolean(busy)}>{busy === "save" ? "正在保存…" : dialog.kind === "thread" ? "保存线索" : dialog.kind === "review" ? "保存回顾" : "保存记录"}</button></div></footer></form></BoardModal>}
  </section>;
}
