"use client";

import { useEffect, useRef, useState } from "react";
import { AREAS, type Area, type ImportDraft, type Task, type TaskInput, type WorkspaceData } from "@/lib/types";
import { chinaToday, displayDate } from "@/lib/dates";
import { parseImport } from "@/lib/import";
import { request, IS_STATIC_PREVIEW, APP_BASE_PATH, APP_VERSION } from "@/lib/client";
import { emptyLifeData, type LifeData, type LifeBoardData } from "@/lib/life";
import { mergeReadingLibraries, type ReadingLibrary } from "@/lib/reading";
import ReadingPanel, { type ReadingTaskDraft, type ReadingThoughtDraft } from "@/components/ReadingPanel";
import ThoughtsPanel from "@/components/ThoughtsPanel";
import LifeBoard from "@/components/LifeBoard";
import ReadingRevisit, { type ReadingNoteRequest } from "@/components/ReadingRevisit";
import { useReadingRevisit } from "@/components/useReadingRevisit";
import WeReadSync from "@/components/WeReadSync";
import MediaPanel from "@/components/MediaPanel";
import { useTraktAutoSync } from "@/components/useTraktAutoSync";
import { mergeMediaLibraries } from "@/lib/media";
import { mediaWorkCount } from "@/lib/media-view";
import { clearPosterWorkerCache } from "@/lib/poster-worker-client";
import { clearMediaPosterCache } from "@/lib/media-posters";
import type { MediaEntry, MediaLibrary } from "@/lib/media";
import { MAX_BACKUP_BYTES } from "@/lib/backup";

type TaskView = "today" | "inbox" | "all" | "done";
type View = TaskView | "reading" | "media" | "thoughts" | "life";
type IconName = "sun" | "inbox" | "list" | "check" | "plus" | "arrow" | "close" | "search" | "download" | "upload" | "edit" | "trash" | "leaf" | "spark" | "file" | "chevron" | "book" | "film";

function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/></>,
    film: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4"/></>,
    inbox: <><path d="m4 5-2 9v5h20v-5l-2-9H4Z"/><path d="M2 14h6l2 3h4l2-3h6"/></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/></>,
    check: <path d="m5 12 4 4L19 6"/>, plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></>, upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15v5Z"/></>, trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
    leaf: <><path d="M5 18C-1 6 13 2 21 3c0 9-3 18-13 17M4 22 17 8"/></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,
    file: <><path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8M8 16h6"/></>, chevron: <path d="m9 5 7 7-7 7"/>,
    book: <><path d="M12 5C8 3 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-1-10 1Z"/><path d="M12 5v15"/></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const EMPTY: WorkspaceData = { tasks: [], sources: [] };
const NAV: { id: View; title: string; icon: IconName }[] = [
  { id: "life", title: "人生看板", icon: "leaf" },
  { id: "reading", title: "阅读", icon: "book" }, { id: "media", title: "影音", icon: "film" }, { id: "thoughts", title: "思考", icon: "file" },
  { id: "all", title: "事务", icon: "list" },
];
const TASK_NAV: { id: TaskView; title: string }[] = [
  { id: "today", title: "今天", }, { id: "inbox", title: "收件箱" },
  { id: "all", title: "全部待办" }, { id: "done", title: "已完成" },
];
const TITLES: Record<TaskView, { title: string; description: string; empty: string; detail: string }> = {
  today: { title: "今天，把生活理顺一点。", description: "留一点空间，给重要的事，也给自己。", empty: "今天还没有安排", detail: "从一个小行动开始，或把脑海里的事情一次收进来。" },
  inbox: { title: "先收下来，慢慢理清。", description: "这里放着尚未安排日期，或需要再想一想的事。", empty: "收件箱很清爽", detail: "尚未安排日期或待确认的事项，会出现在这里。" },
  all: { title: "日常事务，放在这里。", description: "需要处理的事可以在这里安排，给生活留出空间。", empty: "你的待办，从这里开始", detail: "先记录一件事，或者导入聊天中整理好的整批待办。" },
  done: { title: "走过的每一步，都算数。", description: "看看已经做成的事，也给自己一点肯定。", empty: "完成的事情会留在这里", detail: "在待办前打一个勾，就能留下一个小小的进展。" },
};

function freshTask(): TaskInput {
  return { title: "", notes: "", area: "生活", priority: "normal", plannedDate: null, dueDate: null, needsClarification: [], sourceExcerpt: "" };
}

const EXAMPLE = JSON.stringify({ version: 1, sourceText: "最近有点乱，想把收拾书桌、预约一次洗牙、读完手头那本书这几件事记下来。洗牙具体去哪家还没想好。", tasks: [
  { ...freshTask(), title: "收拾书桌", notes: "整理桌面和抽屉", sourceExcerpt: "收拾书桌" },
  { ...freshTask(), title: "预约洗牙", area: "健康", needsClarification: ["选择诊所"], sourceExcerpt: "预约一次洗牙，具体去哪家还没想好" },
  { ...freshTask(), title: "读完手头的书", area: "阅读", sourceExcerpt: "读完手头那本书" },
] }, null, 2);

function TaskFields({ value, onChange, prefix, disabled = false }: { value: TaskInput; onChange: (value: TaskInput) => void; prefix: string; disabled?: boolean }) {
  const change = <K extends keyof TaskInput>(key: K, next: TaskInput[K]) => onChange({ ...value, [key]: next });
  return <fieldset className="task-fields" disabled={disabled}>
    <label className="field field-full" htmlFor={`${prefix}-title`}>要做什么<input id={`${prefix}-title`} value={value.title} maxLength={300} onChange={e => change("title", e.target.value)} placeholder="写成一个可以行动的小步骤" required/></label>
    <label className="field" htmlFor={`${prefix}-area`}>生活领域<select id={`${prefix}-area`} value={value.area} onChange={e => change("area", e.target.value as Area)}>{AREAS.map(area => <option key={area}>{area}</option>)}</select></label>
    <label className="field" htmlFor={`${prefix}-priority`}>优先级<select id={`${prefix}-priority`} value={value.priority} onChange={e => change("priority", e.target.value as TaskInput["priority"])}><option value="normal">普通</option><option value="high">重要</option></select></label>
    <label className="field" htmlFor={`${prefix}-planned`}>计划日期<input type="date" id={`${prefix}-planned`} value={value.plannedDate || ""} onChange={e => change("plannedDate", e.target.value || null)}/></label>
    <label className="field" htmlFor={`${prefix}-due`}>截止日期<input type="date" id={`${prefix}-due`} value={value.dueDate || ""} onChange={e => change("dueDate", e.target.value || null)}/></label>
    <label className="field field-full" htmlFor={`${prefix}-notes`}>备注<textarea id={`${prefix}-notes`} rows={2} value={value.notes} onChange={e => change("notes", e.target.value)} placeholder="补充细节、链接或准备事项"/></label>
    <label className="field field-full" htmlFor={`${prefix}-clarify`}>待确认事项<span className="field-hint">每行一项；没有就留空</span><textarea id={`${prefix}-clarify`} rows={2} value={value.needsClarification.join("\n")} onChange={e => change("needsClarification", e.target.value.split("\n"))} placeholder="例如：和对方确认时间"/></label>
  </fieldset>;
}

export default function Home() {
  const [data, setData] = useState<WorkspaceData>(EMPTY);
  const [life, setLife] = useState<LifeData>(emptyLifeData);
  const [thoughtDraft, setThoughtDraft] = useState<ReadingThoughtDraft | null>(null);
  const [readingNoteRequest, setReadingNoteRequest] = useState<ReadingNoteRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setView] = useState<View>("life");
  const [search, setSearch] = useState("");
  const [area, setArea] = useState<Area | "all">("all");
  const [today, setToday] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [modal, setModal] = useState<"import" | "manual" | "edit" | null>(null);
  const [importText, setImportText] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [included, setIncluded] = useState<boolean[]>([]);
  const [sample, setSample] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskInput>(freshTask);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [lifeSaving, setLifeSaving] = useState(false);
  const lifeWorking = useRef(false);
  const batchId = useRef<string | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const trakt = useTraktAutoSync({ ready: !loading && !loadFailed, library: life.media, onImport: mergeIncomingMedia, onArtwork: mergeIncomingPosters });
  const readingRevisit = useReadingRevisit(life.reading, !loading && !loadFailed);

  async function load() {
    setLoading(true); setLoadFailed(false); setError("");
    try {
      const [tasks, lifeData] = await Promise.all([request<WorkspaceData>("/api/tasks"), request<LifeData>("/api/life")]);
      setData(tasks); setLife(lifeData);
    }
    catch (cause) { setLoadFailed(true); setError(cause instanceof Error ? cause.message : "暂时无法读取生活记录，请重试。"); }
    finally { setLoading(false); }
  }
  useEffect(() => { setToday(chinaToday()); void load(); const timer = setInterval(() => setToday(chinaToday()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { const params = new URLSearchParams(window.location.search); if (params.has("state") && (params.has("code") || params.has("error"))) setView("media"); }, []);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.focus();
    document.body.style.overflow = "hidden";
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) { setModal(null); return; }
      if (event.key !== "Tab" || !dialog) return;
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'));
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [modal, saving]);

  const isToday = (task: Task) => task.status === "todo" && (task.plannedDate === today || Boolean(task.dueDate && task.dueDate <= today));
  const isInbox = (task: Task) => task.status === "todo" && ((!task.plannedDate && !task.dueDate) || task.needsClarification.some(item => item.trim()));
  const counts: Record<View, number> = { today: data.tasks.filter(isToday).length, inbox: data.tasks.filter(isInbox).length, all: data.tasks.filter(t => t.status === "todo").length, done: data.tasks.filter(t => t.status === "done").length, reading: life.reading.books.length, media: mediaWorkCount(life.media.entries), thoughts: life.thoughts.length, life: life.board.threads.filter(thread => thread.state === "active").length };
  const tasks = data.tasks.filter(task => view === "today" ? isToday(task) : view === "inbox" ? isInbox(task) : view === "done" ? task.status === "done" : task.status === "todo")
    .filter(task => area === "all" || task.area === area)
    .filter(task => `${task.title} ${task.notes} ${task.sourceExcerpt} ${task.needsClarification.join(" ")}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => view === "done" ? (b.completedAt || "").localeCompare(a.completedAt || "") : Number(b.priority === "high") - Number(a.priority === "high") || (a.dueDate || a.plannedDate || "9999").localeCompare(b.dueDate || b.plannedDate || "9999") || b.createdAt.localeCompare(a.createdAt));
  const selectedCount = included.filter(Boolean).length;
  const taskView = view === "today" || view === "inbox" || view === "all" || view === "done";
  const active = TITLES[taskView ? view : "today"];
  const currentName = (taskView ? TASK_NAV : NAV).find(item => item.id === view)?.title;
  const dateLabel = today ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(new Date(`${today}T12:00:00+08:00`)) : "上海时间";
  function selectView(next: View) { if (lifeWorking.current) return; setView(next); setArea("all"); setSearch(""); setExpanded(null); setReadingNoteRequest(null); }
  function openReadingNote(request: ReadingNoteRequest) {
    if (lifeWorking.current) return;
    selectView("reading");
    setReadingNoteRequest(request);
  }
  function openImport() { setModal("import"); setModalError(""); }
  function openManual() { setTaskForm(freshTask()); setEditingId(null); setModalError(""); batchId.current = null; setModal("manual"); }
  function createLinkedTask(input: ReadingTaskDraft) {
    const notes = input.notes.slice(0, 5_000);
    setTaskForm({ ...freshTask(), title: input.title.slice(0, 300), notes, area: input.area ?? "阅读", sourceExcerpt: input.notes.slice(0, 2_000) });
    setEditingId(null); setModalError(""); batchId.current = null; setModal("manual");
    if (notes.length < input.notes.length) setStatus("待办备注节选前 5000 字，全文保留在阅读或思考中。");
  }
  async function saveLifeSection<K extends keyof LifeData>(section: K, next: LifeData[K]) {
    if (lifeWorking.current || restoring || clearing) throw new Error("正在保存或恢复记录，请稍后重试。当前草稿已保留。");
    lifeWorking.current = true; setLifeSaving(true);
    try {
      const latest = await request<LifeData>("/api/life");
      if (JSON.stringify(latest[section]) !== JSON.stringify(life[section])) {
        setLife(latest);
        throw new Error("这些记录已在另一个页面更新，请核对最新内容后重新保存。当前草稿已保留。");
      }
      const saved = await request<LifeData>("/api/life", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section, expected: latest[section], value: next }) });
      setLife(saved);
    } finally { lifeWorking.current = false; setLifeSaving(false); }
  }
  async function saveReading(next: ReadingLibrary) { await saveLifeSection("reading", next); }
  async function saveThoughts(next: LifeData["thoughts"]) { await saveLifeSection("thoughts", next); }
  async function saveBoard(next: LifeBoardData) { await saveLifeSection("board", next); }
  async function saveMedia(next: MediaLibrary) { await saveLifeSection("media", next); }
  async function mergeIncomingMedia(incoming: MediaLibrary) {
    if (lifeWorking.current || restoring || clearing) throw new Error("正在保存资料，请稍后更新。旧记录保留。");
    lifeWorking.current = true; setLifeSaving(true);
    try {
      const latest = await request<LifeData>("/api/life");
      const value = mergeMediaLibraries(latest.media, incoming);
      const saved = await request<LifeData>("/api/life", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section: "media", expected: latest.media, value }) });
      setLife(saved);
    } finally { lifeWorking.current = false; setLifeSaving(false); }
  }
  async function mergeIncomingPosters(posters: ReadonlyMap<string, string>) {
    if (lifeWorking.current || restoring || clearing) throw new Error("正在保存资料，请稍后补图。旧记录保留。");
    lifeWorking.current = true; setLifeSaving(true);
    try {
      const latest = await request<LifeData>("/api/life");
      const value = { ...latest.media, entries: latest.media.entries.map(entry => posters.has(entry.id) ? { ...entry, poster: posters.get(entry.id)! } : entry) };
      if (JSON.stringify(value) === JSON.stringify(latest.media)) return;
      const saved = await request<LifeData>("/api/life", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section: "media", expected: latest.media, value }) });
      setLife(saved);
    } finally { lifeWorking.current = false; setLifeSaving(false); }
  }
  async function rememberMedia(entry: MediaEntry) {
    const watched = [...entry.history].sort((a, b) => Date.parse(b.watchedAt.length === 10 ? `${b.watchedAt}T12:00:00+08:00` : b.watchedAt) - Date.parse(a.watchedAt.length === 10 ? `${a.watchedAt}T12:00:00+08:00` : a.watchedAt))[0]?.watchedAt;
    const text = `《${entry.title}》\n${entry.thought || "回看这部作品留下的观影记录。"}`;
    await saveBoard({ ...life.board, observations: [...life.board.observations, { id: crypto.randomUUID(), area: "影音", kind: entry.thought ? "feeling" : "experience", text: text.slice(0, 5_000), date: watched ? watched.length === 10 ? watched : chinaToday(new Date(watched)) : chinaToday(), createdAt: new Date().toISOString() }] });
    if (text.length > 5_000) setStatus("人生看板保留前 5000 字，完整感想仍在影音记录中。");
  }
  function editTask(task: Task) { setTaskForm({ ...task }); setEditingId(task.id); setModalError(""); setModal("edit"); }
  function readImport() {
    setModalError(""); batchId.current = null;
    try {
      const next = parseImport(importText);
      setDraft({ ...next, sourceText: originalText.trim() || next.sourceText || importText });
      setIncluded(next.tasks.map(() => true));
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : "没有找到可导入的待办，请检查格式。"); }
  }
  function updateDraft(index: number, value: TaskInput) {
    batchId.current = null; setDraft(previous => previous ? { ...previous, tasks: previous.tasks.map((task, i) => i === index ? value : task) } : null);
  }
  async function saveNewTasks(tasksToSave: TaskInput[], sourceText: string) {
    batchId.current ||= crypto.randomUUID();
    return request<WorkspaceData>("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: batchId.current, sourceText, tasks: tasksToSave.map(task => ({ ...task, title: task.title.trim(), needsClarification: task.needsClarification.map(item => item.trim()).filter(Boolean) })) }) });
  }
  async function confirmImport() {
    if (!draft || saving) return;
    const selection = draft.tasks.filter((_, index) => included[index]);
    if (!selection.length || selection.some(task => !task.title.trim())) { setModalError("请至少保留一条待办，并为每条填写标题。"); return; }
    setSaving(true); setModalError("");
    try {
      setData(await saveNewTasks(selection, draft.sourceText)); setStatus(`已保存 ${selection.length} 条待办，可以在全部待办中查看。`);
      setModal(null); setDraft(null); setImportText(""); setOriginalText(""); setSample(false); batchId.current = null; selectView("all");
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : "保存失败，请重试。整理结果已保留。"); }
    finally { setSaving(false); }
  }
  async function saveManual(event: React.FormEvent) {
    event.preventDefault(); if (saving) return;
    if (!taskForm.title.trim()) { setModalError("请填写待办标题。"); return; }
    setSaving(true); setModalError("");
    try {
      if (modal === "edit" && editingId) {
        const cleanForm: TaskInput = { title: taskForm.title.trim(), notes: taskForm.notes, area: taskForm.area, priority: taskForm.priority, plannedDate: taskForm.plannedDate, dueDate: taskForm.dueDate, needsClarification: taskForm.needsClarification.map(item => item.trim()).filter(Boolean), sourceExcerpt: taskForm.sourceExcerpt };
        const updated = await request<Task>(`/api/tasks/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cleanForm) });
        setData(previous => ({ ...previous, tasks: previous.tasks.map(task => task.id === updated.id ? updated : task) })); setStatus("待办已更新。");
      } else { setData(await saveNewTasks([{ ...taskForm, sourceExcerpt: taskForm.sourceExcerpt || taskForm.title.trim() }], [taskForm.title.trim(), taskForm.notes].filter(Boolean).join("\n"))); setStatus("已保存一条新的待办。"); }
      setModal(null); batchId.current = null;
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setSaving(false); }
  }
  async function toggleTask(task: Task) {
    if (busyTask) return; setBusyTask(task.id); setError("");
    try {
      const updated = await request<Task>(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: task.status === "done" ? "todo" : "done" }) });
      setData(previous => ({ ...previous, tasks: previous.tasks.map(item => item.id === task.id ? updated : item) })); setStatus(task.status === "todo" ? `已完成：${task.title}` : `已恢复待办：${task.title}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新失败，请重试。"); }
    finally { setBusyTask(null); }
  }
  async function deleteTask(task: Task) {
    if (busyTask || !window.confirm(`删除「${task.title}」？此操作无法撤销，其他待办不会受影响。该批最后一条待办的原文也会删除。`)) return;
    setBusyTask(task.id); setError("");
    try { await request(`/api/tasks/${task.id}`, { method: "DELETE" }); setData(previous => ({ ...previous, tasks: previous.tasks.filter(item => item.id !== task.id) })); setStatus("待办已删除。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败，请重试。"); }
    finally { setBusyTask(null); }
  }
  async function exportData() {
    if (exporting) return; setExporting(true); setError("");
    try {
      const backup = await request("/api/export"); const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `有序-备份-${today}.json`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url); setStatus("完整备份已导出，包含生活线索、经历、回顾、阅读、思考与事务。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "导出失败，请重试。"); }
    finally { setExporting(false); }
  }
  async function restoreData(file: File | undefined) {
    if (!file || restoring || clearing || lifeWorking.current) return; setRestoring(true); setError("");
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error("备份文件过大，请选择小于 20 MB 的 JSON 文件。");
      const backup: unknown = JSON.parse(await file.text());
      setData(await request<WorkspaceData>("/api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backup) })); setLife(await request<LifeData>("/api/life")); setStatus("备份已恢复，原有内容保留，重复内容已跳过。");
    } catch (cause) { setError(cause instanceof SyntaxError ? "这个文件不是有效的 JSON 备份。" : cause instanceof Error ? cause.message : "恢复失败，请检查备份文件。"); }
    finally { setRestoring(false); if (restoreInput.current) restoreInput.current.value = ""; }
  }
  async function clearBrowserData() {
    if (!IS_STATIC_PREVIEW || clearing || lifeWorking.current || !window.confirm("清空这个浏览器中保存的全部生活线索、经历、回顾、阅读、影音、思考与待办、Trakt 连接及海报缓存？此操作无法撤销。请先导出需要保留的备份；已导出的文件不会受影响。")) return;
    setClearing(true); setError("");
    try {
      await trakt.disconnect();
      await request("/api/workspace", { method: "DELETE" });
      setData(EMPTY); setLife(emptyLifeData()); setThoughtDraft(null); setDraft(null); setImportText(""); setOriginalText(""); setIncluded([]); setSample(false); batchId.current = null;
      selectView("life");
      await clearMediaPosterCache();
      await clearPosterWorkerCache();
      setStatus("当前浏览器中的生活记录、阅读、影音、思考、待办、原文和海报缓存已清空。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "清空失败，请重试。"); }
    finally { setClearing(false); }
  }

  return <div className="workspace">
    <aside className="sidebar">
      <a href={`${APP_BASE_PATH}/`} className="brand" aria-label="有序首页"><span className="brand-mark"><Icon name="leaf" size={24}/></span><span>有序<small>人生工作台</small></span></a>
      <div className="sidebar-heading">我的空间</div>
      <nav className="navigation" aria-label="主导航">{NAV.map(item => <button key={item.id} className={`nav-item ${(view === item.id || (item.id === "all" && taskView)) ? "active" : ""}`} aria-current={view === item.id || (item.id === "all" && taskView) ? "page" : undefined} disabled={lifeSaving || restoring || clearing} onClick={() => selectView(item.id)}><Icon name={item.icon}/><span>{item.title}</span><small>{loading ? "·" : counts[item.id]}</small></button>)}</nav>
      <div className="sidebar-note"><span className="tiny-star">✳</span><p>生活的线头，慢慢理清。<br/>看见经历，也看见自己。</p><span className="note-line"/></div>
      <div className="sidebar-bottom"><span className="save-dot"/>个人看板<span className="version">v{APP_VERSION}</span></div>
    </aside>

    <main className="main">
      <header className="topbar"><span className="breadcrumb">我的空间 <span>/</span> <strong>{currentName}</strong></span><span className="date-label"><Icon name="sun" size={16}/>{dateLabel}</span></header>
      <div className="main-content">
        {taskView && <section className="page-intro"><div><p className="eyebrow">A LITTLE ORDER, A LITTLE MORE SPACE</p><h1>{active.title.split("，")[0]}，<span className="intro-title-tail">{active.title.split("，")[1]}</span></h1><p className="intro-description">{active.description}</p></div><button className="button primary collect-button" onClick={openImport} disabled={loading || loadFailed}><Icon name="plus" size={18}/>收集待办</button></section>}

        <div className="feedback" aria-live="polite" role="status">{status && <p className="success-message"><Icon name="check" size={16}/>{status}<button className="dismiss" aria-label="关闭提示" onClick={() => setStatus("")}><Icon name="close" size={15}/></button></p>}</div>
        {error && <div className="error-message" role="alert"><span>{error}</span>{loadFailed && <button onClick={() => void load()}>重新加载</button>}<button className="dismiss" onClick={() => setError("")} aria-label="关闭错误提示"><Icon name="close" size={15}/></button></div>}

        {taskView && <><section className="overview" aria-label="待办概览"><button className={`stat-card ${view === "today" ? "selected" : ""}`} onClick={() => selectView("today")}><span className="stat-icon green"><Icon name="sun"/></span><span className="stat-label">今天要做<small>今天安排 · 到期 · 逾期</small></span><strong>{loading ? "—" : counts.today}<span>件</span></strong></button><button className={`stat-card ${view === "inbox" ? "selected" : ""}`} onClick={() => selectView("inbox")}><span className="stat-icon peach"><Icon name="inbox"/></span><span className="stat-label">留待整理<small>未安排日期 · 待确认</small></span><strong>{loading ? "—" : counts.inbox}<span>件</span></strong></button><button className={`stat-card ${view === "done" ? "selected" : ""}`} onClick={() => selectView("done")}><span className="stat-icon neutral"><Icon name="check"/></span><span className="stat-label">已经完成<small>每一小步，都有意义</small></span><strong>{loading ? "—" : counts.done}<span>件</span></strong></button></section>

        <nav className="task-view-navigation" aria-label="事务视图">{TASK_NAV.map(item => <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => selectView(item.id)}>{item.title}<small>{counts[item.id]}</small></button>)}</nav>
        <div className="content-grid"><section className="task-panel" aria-label={currentName}>
          <div className="panel-heading"><div><span className="section-kicker">{view === "today" ? "FOCUS ON TODAY" : view === "done" ? "SMALL WINS" : "MAKE ROOM FOR LIFE"}</span><h2>{view === "today" ? "今天的安排" : currentName}<span className="count-pill">{tasks.length}</span></h2></div>{view !== "done" && <button className="text-button" onClick={openManual} disabled={loading || loadFailed}><Icon name="plus" size={16}/>新建待办</button>}</div>
          <div className="list-tools"><label className="search-box"><Icon name="search" size={17}/><input aria-label="搜索待办" placeholder="搜索待办、备注…" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button aria-label="清空搜索" onClick={() => setSearch("")}><Icon name="close" size={14}/></button>}</label><select aria-label="按生活领域筛选" value={area} onChange={event => setArea(event.target.value as Area | "all")}><option value="all">所有领域</option>{AREAS.map(item => <option key={item}>{item}</option>)}</select></div>
          {loading ? <div className="empty-state"><div className="loading-ring"/><h3>正在打开你的工作台</h3><p>稍等片刻，生活的安排马上就好。</p></div> : loadFailed ? <div className="empty-state"><span className="empty-art"><Icon name="inbox" size={38}/></span><h3>暂时无法打开待办</h3><p>请重新加载。已有内容不会因此被修改。</p><button className="button secondary" onClick={() => void load()}>重新加载</button></div> : !tasks.length ? <div className="empty-state"><div className="empty-art"><span className="art-line art-line-one"/><Icon name={view === "done" ? "check" : "leaf"} size={39}/><span className="art-spark">✳</span><span className="art-line art-line-two"/></div><h3>{search || area !== "all" ? "没有找到符合条件的待办" : active.empty}</h3><p>{search || area !== "all" ? "换一个关键词，或查看所有生活领域。" : active.detail}</p>{search || area !== "all" ? <button className="button secondary" onClick={() => { setSearch(""); setArea("all"); }}>清除筛选</button> : view === "done" ? <button className="button secondary" onClick={() => selectView("all")}>看看我的待办<Icon name="arrow" size={16}/></button> : <button className="button secondary" onClick={openImport}>收集第一批待办<Icon name="arrow" size={16}/></button>}{view === "today" && counts.all > 0 && <button className="text-button empty-secondary" onClick={() => selectView("all")}>查看其余 {counts.all} 件待办</button>}<span className="empty-caption">小事有着落，心里就宽一点。</span></div> : <div className="task-list">{tasks.map(task => {
            const overdue = task.status === "todo" && Boolean(task.dueDate && task.dueDate < today);
            const source = data.sources.find(record => record.id === task.sourceId);
            return <article key={task.id} className={`task-row ${task.status === "done" ? "completed" : ""}`}><div className="task-top"><button className={`task-checkbox ${task.status === "done" ? "checked" : ""}`} aria-label={task.status === "done" ? `撤销完成：${task.title}` : `完成：${task.title}`} aria-pressed={task.status === "done"} disabled={Boolean(busyTask)} onClick={() => void toggleTask(task)}>{task.status === "done" && <Icon name="check" size={14}/>}</button><button className="task-title-button" onClick={() => setExpanded(expanded === task.id ? null : task.id)} aria-expanded={expanded === task.id}><span className="task-title">{task.title}</span><span className="task-meta"><span className={`area-tag area-${task.area}`}>{task.area}</span>{task.priority === "high" && <span className="priority-tag">重要</span>}{task.plannedDate && <span>计划 {displayDate(task.plannedDate)}</span>}{task.dueDate && <span className={overdue ? "overdue" : ""}>{overdue ? "已逾期 · " : "截止 "}{displayDate(task.dueDate)}</span>}{task.needsClarification.some(item => item.trim()) && <span className="clarify-tag">待确认</span>}</span></button><button className={`icon-button expand-button ${expanded === task.id ? "expanded" : ""}`} onClick={() => setExpanded(expanded === task.id ? null : task.id)} aria-label={expanded === task.id ? `收起：${task.title}` : `查看详情：${task.title}`}><Icon name="chevron" size={17}/></button></div>{expanded === task.id && <div className="task-details">{task.notes && <div className="detail-block"><h4>备注</h4><p>{task.notes}</p></div>}{task.needsClarification.some(item => item.trim()) && <div className="detail-block"><h4>还有这些需要确认</h4><ul>{task.needsClarification.filter(item => item.trim()).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}{task.sourceExcerpt && <div className="detail-block"><h4>对应的原话</h4><blockquote>{task.sourceExcerpt}</blockquote></div>}{source && <details className="original-record"><summary>查看这批待办的原文</summary><pre>{source.text}</pre></details>}<div className="task-actions"><button className="text-button" onClick={() => editTask(task)} disabled={Boolean(busyTask)}><Icon name="edit" size={15}/>编辑待办</button><button className="text-button danger" onClick={() => void deleteTask(task)} disabled={Boolean(busyTask)}><Icon name="trash" size={15}/>删除</button></div></div>}</article>;
          })}</div>}
          {view === "today" && tasks.length > 0 && <div className="panel-footnote"><span>今天之外的事，也已妥善收好。</span><button className="text-button" onClick={() => selectView("all")}>全部待办<Icon name="arrow" size={14}/></button></div>}
        </section>

        <aside className="right-column"><section className="collection-card"><div className="collection-icon"><Icon name="spark" size={24}/></div><p className="section-kicker">日常事务收集</p><h2>想到哪里，<br/>就先说到哪里。</h2><p className="collection-description">需要处理的琐事和安排，<br/>可以通过聊天整理后放在这里。</p><ol className="collection-steps"><li><span>01</span><div>在聊天里随意说<p>像和朋友聊天，不用先整理。</p></div></li><li><span>02</span><div>让助手拆成待办<p>复制整理好的 JSON 或清单。</p></div></li><li><span>03</span><div>在这里检查、保存<p>日期、领域和细节，由你定。</p></div></li></ol><button className="button collection-action" onClick={openImport} disabled={loading || loadFailed}>导入整理结果<Icon name="arrow" size={17}/></button><p className="collection-note">不会自动读取当前聊天。</p></section><section className="small-note"><Icon name="leaf" size={18}/><p>不用给每件事都安排今天。<br/>留在收件箱，也是一种安排。</p></section></aside></div>
        </>}
        {view !== "media" && (trakt.connected || trakt.error) && <div className="trakt-auto-status" aria-live="polite">{trakt.busy ? "正在自动更新影音…" : trakt.error || trakt.message || "Trakt 已连接，打开网页自动更新影音。"}<button type="button" className="text-button" onClick={() => selectView("media")}>查看影音</button></div>}
        {!taskView && !loading && !loadFailed && <>
          {view === "reading" && <><ReadingPanel library={life.reading} noteRequest={readingNoteRequest} revisit={<ReadingRevisit controller={readingRevisit} onOpenNote={openReadingNote}/>} onLibraryChange={saveReading} onCreateTask={createLinkedTask} onCreateThought={input => { setThoughtDraft(input); selectView("thoughts"); }}/><WeReadSync onImport={next => saveReading(mergeReadingLibraries(life.reading, next))}/></>}
          {view === "media" && <MediaPanel library={life.media} onChange={saveMedia} onRemember={rememberMedia} trakt={trakt}/>}
          {view === "thoughts" && <ThoughtsPanel thoughts={life.thoughts} library={life.reading} onThoughtsChange={saveThoughts} onCreateTask={createLinkedTask} initialDraft={thoughtDraft} onDraftConsumed={() => setThoughtDraft(null)}/>}
          {view === "life" && <LifeBoard board={life.board} revisit={<ReadingRevisit controller={readingRevisit} onOpenNote={openReadingNote} hideWhenEmpty/>} reading={life.reading} media={life.media} thoughts={life.thoughts} today={today} onBoardChange={saveBoard} onOpenReading={() => selectView("reading")} onOpenMedia={() => selectView("media")} onOpenThoughts={() => selectView("thoughts")}/>}
        </>}
        {!taskView && loading && <p className="domain-loading" role="status">正在打开你的生活记录…</p>}
        {IS_STATIC_PREVIEW && <aside className="preview-notice" aria-label="试用版数据说明"><Icon name="file" size={17}/><div><strong>个人记录与备份</strong><p>数据仅保存在当前浏览器，手机与电脑独立，记得导出备份。</p><p>清除浏览器数据会删除记录；无需连接外部 AI。</p></div></aside>}
        <footer className="page-footer"><span>有序 <span className="footer-dot">·</span> {IS_STATIC_PREVIEW ? "GitHub Pages 试用版" : "给生活一点空间"} <span className="app-version">· v{APP_VERSION}</span></span><div><span className="storage-label">{IS_STATIC_PREVIEW ? "内容仅保存在当前浏览器" : "内容保存在当前服务器"}</span><button className="footer-button" onClick={() => void exportData()} disabled={exporting || loading || loadFailed || clearing || lifeSaving || restoring}><Icon name="download" size={14}/>{exporting ? "正在导出…" : "导出备份"}</button><button className="footer-button" onClick={() => restoreInput.current?.click()} disabled={restoring || loading || loadFailed || clearing || lifeSaving}><Icon name="upload" size={14}/>{restoring ? "正在恢复…" : "恢复备份"}</button>{IS_STATIC_PREVIEW && <button className="footer-button danger" onClick={() => void clearBrowserData()} disabled={clearing || loading || loadFailed || restoring || saving || lifeSaving}><Icon name="trash" size={14}/>{clearing ? "正在清空…" : "清空浏览器数据"}</button>}<input className="visually-hidden" type="file" ref={restoreInput} accept=".json,application/json" aria-label="选择完整备份文件" onChange={event => void restoreData(event.target.files?.[0])}/></div></footer>
      </div>
    </main>

    {modal && <div className="modal-backdrop"><div className={`modal ${modal === "import" ? "import-modal" : ""}`} ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><p className="section-kicker">{modal === "import" ? "COLLECT & CLARIFY" : "ONE SMALL STEP"}</p><h2 id="modal-title">{modal === "import" ? draft ? "检查一下，准备入库。" : "把想法，收进生活里。" : modal === "edit" ? "调整这一步行动。" : "记下一件要做的事。"}</h2></div><button className="icon-button" onClick={() => setModal(null)} disabled={saving} aria-label="关闭窗口"><Icon name="close"/></button></header>{modalError && <div className="modal-error" role="alert">{modalError}</div>}
      {modal === "import" ? <>
        <div className="import-progress"><span className={!draft ? "current" : "complete"}><b>1</b>粘贴整理结果</span><span className="progress-line"/><span className={draft ? "current" : ""}><b>2</b>逐条检查</span><span className="progress-line"/><span><b>3</b>确认保存</span></div>
        {!draft ? <div className="modal-body"><p className="modal-description">先在聊天中把想法告诉助手，再把整理好的结果粘贴到这里。支持 JSON 和 Markdown 待办清单。</p><label className="field import-field" htmlFor="import-content">聊天整理结果<textarea id="import-content" value={importText} rows={9} placeholder={'粘贴整理结果，例如：\n- [ ] 预约洗牙 | 领域：健康 | 待确认：选择诊所\n- [ ] 整理衣柜 | 领域：生活'} onChange={event => { setImportText(event.target.value); setSample(false); batchId.current = null; }}/></label><div className="import-example"><span>还没有整理结果？</span><button className="text-button" onClick={() => { setImportText(EXAMPLE); setOriginalText(""); setSample(true); batchId.current = null; }}>试试示例<Icon name="arrow" size={14}/></button></div>{sample && <div className="sample-banner"><Icon name="file" size={16}/>这是示例，尚未保存。可以先预览，也可以替换成你的内容。</div>}<details className="source-input"><summary>补充你当时说的原文（可选）</summary><label className="field" htmlFor="original-content"><span className="field-hint">保留原文，日后可以回看每条待办的来处。</span><textarea id="original-content" value={originalText} rows={4} onChange={event => { setOriginalText(event.target.value); batchId.current = null; }} placeholder="粘贴你说的那一大段话…"/></label></details><p className="privacy-note"><Icon name="leaf" size={15}/>这里不会调用外部 AI；相对日期和不确定内容需要你确认。</p></div> : <div className="modal-body preview-body"><div className="preview-summary"><p>识别到 <strong>{draft.tasks.length}</strong> 条待办，准备保存 <strong>{selectedCount}</strong> 条。</p><span>取消勾选即可排除</span></div>{sample && <div className="sample-banner">你正在预览示例。点击确认后，保留的示例待办才会保存。</div>}{draft.warnings.length > 0 && <div className="import-warnings"><h3>这些地方，请再看一眼</h3><ul>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}{draft.tasks.map((task, index) => <section key={index} className={`draft-card ${!included[index] ? "excluded" : ""}`}><div className="draft-heading"><label><input type="checkbox" disabled={saving} checked={Boolean(included[index])} onChange={event => { const checked = event.target.checked; setIncluded(previous => previous.map((item, i) => i === index ? checked : item)); batchId.current = null; }}/><span>待办 {String(index + 1).padStart(2, "0")}</span></label><span>{included[index] ? "将保存" : "已排除"}</span></div>{included[index] ? <><TaskFields value={task} onChange={value => updateDraft(index, value)} prefix={`draft-${index}`} disabled={saving}/>{task.sourceExcerpt && <p className="draft-excerpt">原话：{task.sourceExcerpt}</p>}</> : <p className="excluded-title">{task.title}</p>}</section>)}<details className="original-record preview-source"><summary>查看将保留的整批原文</summary><pre>{draft.sourceText}</pre></details></div>}
        <footer className="modal-footer"><span>{draft ? "确认后才会写入工作台。" : "粘贴与预览都不会保存。"}</span><div>{draft && <button className="button secondary" onClick={() => { setDraft(null); setModalError(""); }} disabled={saving}>返回修改</button>}<button className="button primary" onClick={draft ? () => void confirmImport() : readImport} disabled={saving || (!draft && !importText.trim()) || Boolean(draft && selectedCount === 0)}>{saving ? "正在保存…" : draft ? `确认保存 ${selectedCount} 条` : "生成待办预览"}{!saving && <Icon name="arrow" size={17}/>}</button></div></footer>
      </> : <form onSubmit={event => void saveManual(event)}><div className="modal-body"><TaskFields value={taskForm} onChange={value => { setTaskForm(value); batchId.current = null; }} prefix="single" disabled={saving}/>{modal === "edit" && taskForm.sourceExcerpt && <p className="draft-excerpt">原话：{taskForm.sourceExcerpt}</p>}<p className="privacy-note">日期按中国标准时间使用；留空的事项会进入收件箱。</p></div><footer className="modal-footer"><span>一个清晰的小步骤就很好。</span><button className="button primary" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存待办"}<Icon name="check" size={17}/></button></footer></form>}
    </div></div>}
  </div>;
}
