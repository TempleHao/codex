"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { chinaToday } from "@/lib/dates";
import { MAX_MEDIA_IMPORT_BYTES, mediaEntrySchema, mergeMediaLibraries, parseMediaImport, isLegacyTraktPoster, type MediaEntry, type MediaLibrary } from "@/lib/media";
import TraktSync from "./TraktSync";
import type { TraktController } from "./useTraktAutoSync";
import { invalidatePosterWorker } from "@/lib/poster-worker-client";
import { mediaPosterDiagnostics, mediaPosterRecordDiagnostics, type MediaPosterDiagnostics } from "@/lib/media-poster-diagnostics";
import { MediaPoster } from "./MediaPoster";
import { invalidateMediaPoster } from "@/lib/media-posters";
import { buildMediaWorks, viewingDay, workStatus, type MediaWork } from "@/lib/media-view";
import "./media.css";

const KINDS = { movie: "电影", show: "剧集", episode: "单集" };
const STATUSES = { wanted: "想看", watching: "在看", watched: "看过", unclassified: "未分类" };
const GENRES: Record<string, string> = { drama: "剧情", comedy: "喜剧", action: "动作", adventure: "冒险", animation: "动画", crime: "犯罪", documentary: "纪录片", family: "家庭", fantasy: "奇幻", history: "历史", horror: "恐怖", music: "音乐", mystery: "悬疑", romance: "爱情", "science-fiction": "科幻", "sci-fi": "科幻", thriller: "惊悚", war: "战争", western: "西部" };
function watchTime(value: string) { return Date.parse(value.length === 10 ? `${value}T12:00:00+08:00` : value); }
function dateLabel(value: string) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value.length === 10 ? `${value}T12:00:00+08:00` : value)); }

type Draft = { original?: MediaEntry; title: string; kind: "movie" | "show" | "episode"; status: MediaEntry["status"]; year: string; rating: string; watchedAt: string; thought: string };
export default function MediaPanel({ library, onChange, onRemember, trakt }: { library: MediaLibrary; trakt: TraktController; onChange: (next: MediaLibrary) => Promise<void>; onRemember: (entry: MediaEntry) => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [view, setView] = useState<"review" | "library" | "thoughts">("review");
  const [limit, setLimit] = useState(48);
  const [yearChoice, setYearChoice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [json, setJson] = useState("");
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<MediaLibrary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [posterEpoch, setPosterEpoch] = useState(0);
  const [posterRetrying, setPosterRetrying] = useState(false);
  const [diagnosis, setDiagnosis] = useState<MediaPosterDiagnostics | null>(null);
  const [diagnosisCopy, setDiagnosisCopy] = useState("");
  const [recordDiagnosis, setRecordDiagnosis] = useState<{ id: string; text: string } | null>(null);
  const [recordDiagnosisCopy, setRecordDiagnosisCopy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const entries = library.entries;
  const works = useMemo(() => buildMediaWorks(entries), [entries]);
  const calendar = useMemo(() => works.flatMap(work => work.history.map(event => ({ ...event, day: viewingDay(event.watchedAt), workId: work.entry.id }))), [works]);
  const years = useMemo(() => [...new Set(calendar.map(event => event.day.slice(0, 4)))].sort().reverse(), [calendar]);
  const year = years.includes(yearChoice) ? yearChoice : years[0] ?? chinaToday().slice(0, 4);
  const { yearWorks, watchingDays, months, lastByWork, recent, genres } = useMemo(() => {
    const yearHistory = calendar.filter(event => event.day.startsWith(year));
    const watchingDays = new Set(yearHistory.map(event => event.day));
    const lastByWork = new Map<string, string>();
    for (const event of yearHistory) {
      const previous = lastByWork.get(event.workId);
      if (!previous || watchTime(event.watchedAt) > watchTime(previous)) lastByWork.set(event.workId, event.watchedAt);
    }
    const yearWorks = works.filter(work => lastByWork.has(work.entry.id));
    const months = Array.from({ length: 12 }, (_, index) => [...watchingDays].filter(day => Number(day.slice(5, 7)) === index + 1).length);
    const recent = [...yearWorks].sort((a, b) => watchTime(lastByWork.get(b.entry.id)!) - watchTime(lastByWork.get(a.entry.id)!)).slice(0, 8);
    const preferences = new Map<string, number>();
    yearWorks.forEach(work => work.entry.genres.forEach(genre => preferences.set(genre, (preferences.get(genre) ?? 0) + 1)));
    const genres = [...preferences].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { yearWorks, watchingDays, months, lastByWork, recent, genres };
  }, [calendar, works, year]);
  const lastInYear = (work: MediaWork) => lastByWork.get(work.entry.id);
  const thoughtful = works.filter(work => work.thoughts.length > 0);
  const visible = works.filter(work => kind === "all" || work.entry.kind === kind).filter(work => status === "all" || workStatus(work) === status).filter(work => [work.entry.title, ...work.episodes.map(episode => episode.title)].join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const currentWork = works.find(work => work.entry.id === selected);
  const current = currentWork?.entry;
  const storedCurrent = current && entries.find(entry => entry.id === current.id);
  const seasons = [...new Set(currentWork?.episodes.map(episode => episode.season!) ?? [])].sort((a, b) => a - b);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (current && !draft) { if (dialog && !dialog.open) dialog.showModal(); }
    else if (dialog?.open) dialog.close();
  }, [current?.id, draft]);
  function closeDetail() { dialogRef.current?.close(); setSelected(null); }

  async function run(action: () => Promise<void>, note: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); setMessage(note); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存没有完成，请重试。草稿仍在这里。"); }
    finally { setBusy(false); }
  }
  function edit(entry?: MediaEntry) {
    closeDetail();
    setError(""); setImporting(false);
    setDraft({ original: entry, title: entry?.title ?? "", kind: entry?.kind ?? "movie", status: entry?.status ?? "wanted", year: entry?.year?.toString() ?? "", rating: entry?.rating?.toString() ?? "", watchedAt: "", thought: entry?.thought ?? "" });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    const { original } = draft;
    if (original && JSON.stringify(original) !== JSON.stringify(entries.find(entry => entry.id === original.id))) { setError("这部作品已自动更新，草稿仍保留。请先核对最新记录，再重新打开编辑。"); return; }
    const parsed = mediaEntrySchema.safeParse({ ...original, id: original?.id ?? `manual:${crypto.randomUUID()}`, title: draft.title, kind: draft.kind, status: draft.status, genres: original?.genres ?? [], year: draft.year ? Number(draft.year) : undefined, rating: draft.rating ? Number(draft.rating) : undefined, thought: draft.thought,
      history: [...(original?.history ?? []), ...(draft.watchedAt ? [{ id: `manual:${crypto.randomUUID()}`, watchedAt: draft.watchedAt }] : [])] });
    if (!parsed.success) { setError("请检查片名、年份、评分和观看日期。评分为 0 到 10 分。"); return; }
    await run(async () => { await onChange({ ...library, entries: entries.some(entry => entry.id === parsed.data.id) ? entries.map(entry => entry.id === parsed.data.id ? parsed.data : entry) : [...entries, parsed.data] }); setSelected(parsed.data.kind === "episode" ? parsed.data.showId! : parsed.data.id); setDraft(null); }, "影音记录已保存。");
  }
  function previewJson() { try { setPreview(parseMediaImport(json)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "资料格式无法读取。"); } }
  function checkPosters() {
    setDiagnosis(mediaPosterDiagnostics(entries, [...document.querySelectorAll<HTMLElement>(".media-title-art")].map(element => element.dataset.posterState ?? "loading"), {
      secure: window.isSecureContext, serviceWorker: "serviceWorker" in navigator,
      controlled: Boolean(navigator.serviceWorker?.controller), cacheStorage: "caches" in window, indexedDB: "indexedDB" in window,
    }, trakt.artwork));
    setDiagnosisCopy("");
  }
  async function copyDiagnosis() {
    if (!diagnosis) return;
    try { await navigator.clipboard.writeText(JSON.stringify(diagnosis, null, 2)); setDiagnosisCopy("诊断已复制，不含片名、观看记录或密钥。"); }
    catch { setDiagnosisCopy("可展开下方诊断详细信息，选择文字复制。"); }
  }
  function checkCurrentPoster() {
    if (!current) return;
    const state = dialogRef.current?.querySelector<HTMLElement>("[data-poster-state]")?.dataset.posterState ?? "unknown";
    setRecordDiagnosis({ id: current.id, text: JSON.stringify(mediaPosterRecordDiagnostics(current, state), null, 2) });
    setRecordDiagnosisCopy("");
  }
  async function copyCurrentDiagnosis() {
    if (!recordDiagnosis || recordDiagnosis.id !== current?.id) return;
    try { await navigator.clipboard.writeText(recordDiagnosis.text); setRecordDiagnosisCopy("已复制这部作品的封面诊断。"); }
    catch { setRecordDiagnosisCopy("请展开下方诊断文字，选择后复制。"); }
  }
  async function retryPosters() {
    if (posterRetrying || trakt.busy) return;
    const urls = [...new Set([...document.querySelectorAll<HTMLElement>("[data-poster-failed]")].map(element => element.dataset.posterFailed).filter((url): url is string => Boolean(url)))];
    setPosterRetrying(true); setError("");
    try {
      if (entries.some(entry => entry.traktId && (!entry.poster || isLegacyTraktPoster(entry.poster)))) await trakt.repairArtwork();
      await Promise.all(urls.map(async url => { await invalidateMediaPoster(url); await invalidatePosterWorker(url); }));
      if (urls.length) setPosterEpoch(value => value + 1);
      setMessage(urls.length ? "正在重新加载失败的海报。" : "海报检查完成；已有地址会自动加载，可点击「检查海报」查看具体结果。");
    } catch { setError("海报暂时无法修复，旧记录保留。可点击「检查海报」查看具体阶段。"); }
    finally { setPosterRetrying(false); }
  }
  function exportJson() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `有序-影音-${chinaToday()}.json`; link.click(); URL.revokeObjectURL(url);
  }

  function workCard(work: MediaWork, recalledAt?: string) {
    const entry = work.entry;
    return <button type="button" className="media-title" data-work-id={entry.id} key={entry.id} onClick={() => setSelected(entry.id)}>
      <MediaPoster key={entry.id + ":" + posterEpoch} url={entry.poster} title={entry.title} kind={entry.kind}/>
      <span className="media-title-copy"><strong>{entry.title}</strong>
        <small>{KINDS[entry.kind]}{entry.year ? " · " + entry.year : ""}</small>
        <em>{entry.status === "unclassified" && work.history.length ? "有观看记录" : STATUSES[workStatus(work)]}{entry.rating !== undefined ? " · 我的评分 " + entry.rating + "/10" : ""}</em>
        {work.watchedEpisodeCount > 0 && <small>记录中看过 {work.watchedEpisodeCount} 集</small>}
        {recalledAt && <time dateTime={recalledAt}>{dateLabel(recalledAt)}</time>}
        {work.thoughts.length > 0 && <span className="media-note-mark">有我的感想</span>}
      </span>
    </button>;
  }
  return <section className="media-panel" aria-labelledby="media-heading">
    <header className="media-header">
      <div><p className="eyebrow">STORIES IN MY LIFE</p><h1 id="media-heading">故事，也是人生的线头。</h1><p>回看一部作品，也回看与它相遇的自己。</p></div>
      <button type="button" className="button primary" onClick={() => edit()} disabled={busy}>记一部作品</button>
    </header>
    {error && <p className="media-error" role="alert">{error}</p>}
    {message && <p className="media-message" role="status">{message}</p>}
    <nav className="media-view-nav" aria-label="影音浏览">
      {([["review", "回顾"], ["library", "片单"], ["thoughts", "感想"]] as const).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)}>{label}</button>)}
      <span>{works.length} 部作品</span>
    </nav>
    {trakt.connected && <p className="media-sync-state">{trakt.busy ? "正在更新影音记录…" : "Trakt 已连接 · 打开网页自动更新"}{!trakt.busy && trakt.lastSynced ? " · 最近更新 " + dateLabel(trakt.lastSynced) : ""}</p>}
    {draft && <form className="media-card media-editor" onSubmit={event => void save(event)} aria-label="影音记录表单">
      <header><h2>{draft.original ? "编辑影音记录" : "留下一部作品"}</h2><button type="button" className="text-button" disabled={busy} onClick={() => setDraft(null)}>取消</button></header>
      <fieldset disabled={busy} className="media-form-grid">
        <label className="field media-full">片名<input required maxLength={500} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
        <label className="field">作品类型<select disabled={Boolean(draft.original)} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as Draft["kind"] })}>{Object.entries(KINDS).filter(([value]) => value !== "episode" || draft.original?.kind === "episode").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">观看状态<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as Draft["status"] })}>{Object.entries(STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">上映年份<input type="number" min={1880} max={2200} value={draft.year} onChange={event => setDraft({ ...draft, year: event.target.value })}/></label>
        <label className="field">我的评分<input type="number" min={0} max={10} step={0.5} value={draft.rating} onChange={event => setDraft({ ...draft, rating: event.target.value })} placeholder="0—10，可留空"/></label>
        <label className="field media-full">追加一次观看日期<input type="date" max={chinaToday()} value={draft.watchedAt} onChange={event => setDraft({ ...draft, watchedAt: event.target.value })}/><span>可留空；没有日期的作品保留在片单，不计入年度观看日。</span></label>
        <label className="field media-full">我的感想<textarea rows={4} maxLength={20000} value={draft.thought} onChange={event => setDraft({ ...draft, thought: event.target.value })} placeholder="当时的我，为什么会被这个故事打动？"/></label>
      </fieldset>
      <button type="submit" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存影音记录"}</button>
    </form>}
    {view === "review" && <>
      <section className="media-recent" aria-labelledby="media-recent-heading">
        <header className="media-section-header"><div><h2 id="media-recent-heading">{recent.length ? "最近看过的故事" : "等待写下的故事"}</h2><p>{recent.length ? "它们陪伴过你怎样的一段日子？" : "作品已有了位置，也可以为它补上日期或一句感想。"}</p></div><select aria-label="影音回顾年份" value={year} onChange={event => setYearChoice(event.target.value)}>{(years.length ? years : [year]).map(value => <option key={value} value={value}>{value} 年</option>)}</select></header>
        {(recent.length ? recent : works.slice(0, 8)).length ? <ol className="media-titles">{(recent.length ? recent : works.slice(0, 8)).map(work => <li key={work.entry.id}>{workCard(work, recent.length ? lastInYear(work) : undefined)}</li>)}</ol>
          : <div className="media-empty"><span aria-hidden="true">▷</span><h3>留住故事，也留住当时的自己。</h3><p>记一部作品，或展开下方「连接与资料管理」带回 Trakt 记录。</p></div>}
      </section>
      <section className="media-year-review media-card">
        <header><div><p className="eyebrow">MY VIEWING DAYS</p><h2>与故事相遇的日子</h2></div>

        </header>
        <div className="media-overview" aria-label="影音概览">
          <article><span>看过电影</span><strong>{yearWorks.filter(work => work.entry.kind === "movie").length}<small>部</small></strong></article>
          <article><span>看过剧集</span><strong>{yearWorks.filter(work => work.entry.kind === "show").length}<small>部</small></strong></article>
          <article><span>观看日</span><strong>{watchingDays.size}<small>天</small></strong></article>
        </div>
        <p className="media-muted">按观看日期统计；同日连看多集计一天，整部剧只计一部。</p>
      </section>
      <div className="media-insights">
        <section className="media-card"><h2>生活里的观看节奏</h2><p>{year} 年 · {watchingDays.size} 个观看日</p>
          <div className="media-months" role="img" aria-label={year + "年各月观看日：" + months.map((count, index) => (index + 1) + "月" + count + "天").join("，")}>
            {months.map((count, index) => <div key={index} title={year + "年" + (index + 1) + "月：" + count + "个观看日"}><span>{count || ""}</span><i style={{ height: count ? Math.max(5, count / Math.max(...months, 1) * 88) : 2 }}/><small>{index + 1}月</small></div>)}
          </div><p className="media-muted">日期缺失的记录不填入图表。空白的月份，也只是还没有记录。</p>
        </section>
        <section className="media-card"><h2>这一年常遇到的题材</h2>{genres.length ? <ul className="media-genres">{genres.map(([genre, count]) => <li key={genre}><span>{GENRES[genre] ?? genre}</span><meter min={0} max={Math.max(...genres.map(item => item[1]))} value={count}/><small>{count} 部</small></li>)}</ul> : <p className="media-muted">有观看日期与作品类型后，这里会慢慢形成你的故事地图。</p>}<p className="media-muted">每部作品只计一次。同一部剧不会因集数多而占据全部偏好。</p></section>
      </div>
      {thoughtful.length > 0 && <section className="media-card media-thought-invitation"><div><h2>故事之后，你留下了什么？</h2><p>{thoughtful.length} 部作品留有你的文字。感想无需评分，也无需变成任务。</p></div><button type="button" className="button secondary" onClick={() => setView("thoughts")}>回看我的感想</button></section>}
    </>}
    {view === "library" && <section className="media-card media-library" aria-label="我的片单">
      <header><div><h2>我的片单 <span className="count-pill">{visible.length}</span></h2><p className="media-muted">一部电影、一部剧，各有自己的位置。</p></div></header>
      <div className="media-filters">
        <label className="media-search"><span className="media-sr-only">搜索影音</span><input placeholder="搜索作品或某一集" aria-label="搜索影音" value={search} onChange={event => { setSearch(event.target.value); setLimit(48); }}/></label>
        <select aria-label="筛选影音类型" value={kind} onChange={event => { setKind(event.target.value); setLimit(48); }}><option value="all">所有类型</option><option value="movie">电影</option><option value="show">剧集</option></select>
        <select aria-label="筛选观看状态" value={status} onChange={event => { setStatus(event.target.value); setLimit(48); }}><option value="all">所有状态</option>{Object.entries(STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {visible.length ? <><div className="media-titles">{visible.slice(0, limit).map(work => workCard(work))}</div>{visible.length > limit && <button type="button" className="button secondary media-more" onClick={() => setLimit(limit + 48)}>继续查看片单（还有 {visible.length - limit} 部）</button>}</>
        : <div className="media-empty"><h3>{works.length ? "没有符合条件的作品" : "片单从一个故事开始。"}</h3><p>可以调整筛选，或记下你想留住的作品。</p></div>}
    </section>}
    {view === "thoughts" && <section className="media-feelings" aria-label="我的影音感想">
      <header className="media-section-header"><div><h2>故事之外，我自己的声音。</h2><p>在意过的情节、照见自己的瞬间，以及后来再看的不同感受。</p></div></header>
      {thoughtful.length ? thoughtful.map(work => <article className="media-card media-feeling-card" key={work.entry.id}><header><div><h3>{work.entry.title}</h3><p className="media-muted">{KINDS[work.entry.kind]}{work.lastWatchedAt ? " · 最近观看 " + dateLabel(work.lastWatchedAt) : ""}</p></div><button type="button" className="text-button" onClick={() => setSelected(work.entry.id)}>回看作品 ↗</button></header>
        {work.thoughts.slice(0, 3).map(entry => <div key={entry.id}>{entry.kind === "episode" && <p className="media-muted">第 {entry.season} 季第 {entry.episode} 集</p>}<blockquote className="media-feeling-text">{entry.thought!.length > 400 ? entry.thought!.slice(0, 400) + "…" : entry.thought}</blockquote></div>)}
        {work.thoughts.length > 3 && <button type="button" className="text-button" onClick={() => setSelected(work.entry.id)}>还有 {work.thoughts.length - 3} 份感想，展开回看</button>}
      </article>) : <div className="media-empty"><h3>可以从一句话开始。</h3><p>哪段情节让你停了一下？它让你想起自己生活中的什么？</p><button type="button" className="button secondary" onClick={() => setView("library")}>选一部作品，写下感想</button></div>}
    </section>}
    <details className="media-settings" open={entries.length === 0 || Boolean(trakt.error || trakt.preview) ? true : undefined}>
      <summary>连接与资料管理</summary>
      <div className="media-actions media-tools">
        <button type="button" className="text-button" disabled={posterRetrying || trakt.busy} onClick={() => void retryPosters()}>{posterRetrying ? "正在修复…" : "修复海报"}</button>
        <button type="button" className="text-button" onClick={checkPosters}>检查海报</button>
        <button type="button" className="text-button" onClick={exportJson}>导出影音</button>
        <button type="button" className="text-button" onClick={() => { setImporting(!importing); setPreview(null); }} disabled={busy}>导入影音 JSON</button>
      </div>
      {importing && <section className="media-card media-editor"><h2>导入影音资料</h2>
        <input type="file" accept="application/json,.json" ref={fileRef} aria-label="选择影音 JSON 文件" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > MAX_MEDIA_IMPORT_BYTES) { setError("影音文件过大，最多 5 MB。"); return; } try { setJson(await file.text()); setPreview(null); setError(""); } catch { setError("文件读取没有完成，请重新选择文件。"); } }}/>
        <label className="field">影音资料 JSON<textarea rows={8} value={json} onChange={event => { setJson(event.target.value); setPreview(null); }}/></label>
        <button type="button" className="button secondary" disabled={busy || !json.trim()} onClick={previewJson}>预览影音资料</button>
        {preview && <div className="media-import-preview"><p>本次导入 {buildMediaWorks(preview.entries).length} 部作品，保留 {preview.entries.filter(entry => entry.kind === "episode").length} 条单集记录与 {preview.entries.reduce((sum, entry) => sum + entry.history.length, 0)} 次有日期的观看。</p><button type="button" className="button primary" disabled={busy} onClick={() => void run(async () => { await onChange(mergeMediaLibraries(library, preview)); setPreview(null); setImporting(false); }, "影音资料已合并。")}>确认导入影音</button></div>}
      </section>}
      {diagnosis && <section className="media-card media-poster-diagnostics" aria-label="海报检查结果"><header><h2>海报检查结果</h2><button type="button" className="text-button" onClick={() => void copyDiagnosis()}>复制海报诊断</button></header><p>已有地址 {diagnosis.counts.withAddress} 个 · 缺少地址 {diagnosis.counts.withoutAddress} 个</p><p>画面已显示 {diagnosis.counts.displayed} 处 · 正在等待 {diagnosis.counts.waiting} 处 · 图片响应未能显示 {diagnosis.counts.responseFailed} 处 · 缓存不可用 {diagnosis.counts.cacheUnavailable} 处</p>{diagnosis.artwork && <p>作品详情检查 {diagnosis.artwork.checked} 个：有图 {diagnosis.artwork.found} 个，无图 {diagnosis.artwork.missing} 个，请求失败 {diagnosis.artwork.failed} 个，暂未检查 {diagnosis.artwork.deferred} 个。</p>}<p className="media-muted">只含数量和浏览器能力，不含片名、观看记录、图片地址或密钥。</p>{diagnosisCopy && <p role="status">{diagnosisCopy}</p>}<details><summary>诊断详细信息</summary><pre>{JSON.stringify(diagnosis, null, 2)}</pre></details></section>}
      <TraktSync connection={trakt}/>
    </details>
    <dialog ref={dialogRef} className="media-dialog" aria-label="影音详情" onClose={() => setSelected(null)} onClick={event => { if (event.target === event.currentTarget) closeDetail(); }}>
      {current && currentWork && <article className="media-card media-detail">
        <header className="media-detail-header"><p className="eyebrow">{KINDS[current.kind]}</p><button type="button" className="text-button" onClick={closeDetail}>关闭影音详情</button></header>
        <div className="media-detail-top">
          <div className="media-detail-poster"><MediaPoster key={current.id + ":" + posterEpoch} url={current.poster} title={current.title} kind={current.kind}/></div>
          <div><h2>{current.title}</h2><p>{current.status === "unclassified" && currentWork.history.length ? "有观看记录" : STATUSES[workStatus(currentWork)]}{current.year ? " · " + current.year + " 年" : ""}</p>
            {current.rating !== undefined && <p className="media-own-rating">我的评分 <strong>{current.rating}</strong> / 10</p>}
            {currentWork.watchedEpisodeCount > 0 && <p>记录中看过 {currentWork.watchedEpisodeCount} 集</p>}
            {!storedCurrent && <p className="media-muted">已有单集记录，暂缺整部剧的资料；单集的日期与感想仍可展开查看。</p>}
          </div>
        </div>
        {!current.poster && <p className="media-muted">暂无封面：当前记录没有可用图片地址。{current.imdbId ? "已有 IMDb 编号，可以补查封面。" : "当前记录未包含 IMDb 编号；免费备用图源依赖此编号，部分节目无法通过它获取封面。"} 可在「连接与资料管理」中修复海报，重新补查作品详情。</p>}
        <details className="media-viewing-records media-poster-diagnostics" onToggle={event => { if (event.currentTarget.open) checkCurrentPoster(); }}>
          <summary>这部作品的封面诊断</summary>
          <p className="media-muted">只含作品的公开编号、作品链接与封面状态，不含观看日期、感想或账号密钥。</p>
          {recordDiagnosis?.id === current.id && <><pre>{recordDiagnosis.text}</pre><button type="button" className="text-button" onClick={() => void copyCurrentDiagnosis()}>复制这部作品的封面诊断</button></>}
          {recordDiagnosisCopy && recordDiagnosis?.id === current.id && <p role="status">{recordDiagnosisCopy}</p>}
        </details>
        {currentWork.firstWatchedAt && <div className="media-encounter"><span>在我的生活里</span><p><time dateTime={currentWork.firstWatchedAt}>{dateLabel(currentWork.firstWatchedAt)}</time>{viewingDay(currentWork.firstWatchedAt) !== viewingDay(currentWork.lastWatchedAt!) && <> — <time dateTime={currentWork.lastWatchedAt}>{dateLabel(currentWork.lastWatchedAt!)}</time></>}</p><small>依据已有观看日期</small></div>}
        {current.thought ? <blockquote className="media-thought">{current.thought}</blockquote> : storedCurrent && <p className="media-muted">此刻回看，这个故事留下了什么？可以在「编辑记录与感想」写下自己的答案。</p>}
        <div className="media-actions">
          {storedCurrent && <button type="button" className="button secondary" onClick={() => edit(storedCurrent)} disabled={busy}>编辑记录与感想</button>}
          <button type="button" className="text-button" disabled={busy || !storedCurrent || (!current.thought?.trim() && currentWork.history.length === 0 && current.status !== "watched")} onClick={() => void run(() => onRemember({ ...current, history: currentWork.history.map(({ id, watchedAt }) => ({ id, watchedAt })) }), "这份影音感受已留在人生看板。")}>留在人生看板</button>
        </div>
        {current.history.length > 0 && <details className="media-viewing-records"><summary>{current.kind === "movie" ? "观看与重看记录" : "整部剧的观看记录"} · {current.history.length} 次</summary><ul className="media-history">{[...current.history].sort((a, b) => watchTime(b.watchedAt) - watchTime(a.watchedAt)).map(event => <li key={event.id}><time dateTime={event.watchedAt}>{dateLabel(event.watchedAt)}</time></li>)}</ul></details>}
        {currentWork.episodes.length > 0 && <details className="media-seasons" key={current.id}>
          <summary>分季观看记录 <span>{currentWork.episodes.length} 条单集记录</span></summary>
          <p className="media-muted">保留每一集的日期、重看与感想。没有总集数资料时，不估计整部剧的完成度。</p>
          {seasons.map(season => <details className="media-season" key={season}><summary>第 {season} 季 <span>{currentWork.episodes.filter(episode => episode.season === season).length} 集有记录</span></summary>
            {currentWork.episodes.filter(episode => episode.season === season).map(episode => <article className="media-episode" key={episode.id}>
              <h3>第 {episode.season} 季第 {episode.episode} 集 · {episode.title}</h3>
              {episode.rating !== undefined && <p className="media-muted">我的单集评分 {episode.rating} / 10</p>}
              {episode.history.length ? <ul className="media-history">{[...episode.history].sort((a, b) => watchTime(b.watchedAt) - watchTime(a.watchedAt)).map(event => <li key={event.id}><time dateTime={event.watchedAt}>{dateLabel(event.watchedAt)}</time></li>)}</ul> : <p className="media-muted">没有提供观看日期</p>}
              {episode.thought && <blockquote className="media-episode-thought">{episode.thought}</blockquote>}
              <button type="button" className="text-button" disabled={busy} onClick={() => edit(episode)}>编辑第 {episode.season} 季第 {episode.episode} 集</button>
            </article>)}
          </details>)}
        </details>}
        {current.traktUrl && <a href={current.traktUrl} target="_blank" rel="noopener noreferrer">在 Trakt 查看作品 ↗</a>}
      </article>}
    </dialog>
  </section>;
}
