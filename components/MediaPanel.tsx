"use client";

import { useRef, useState, type FormEvent } from "react";
import { chinaToday } from "@/lib/dates";
import { MAX_MEDIA_IMPORT_BYTES, mediaEntrySchema, mergeMediaLibraries, parseMediaImport, type MediaEntry, type MediaLibrary } from "@/lib/media";
import TraktSync from "./TraktSync";
import type { TraktController } from "./useTraktAutoSync";
import { invalidatePosterWorker } from "@/lib/poster-worker-client";
import { MediaPoster } from "./MediaPoster";
import { invalidateMediaPoster } from "@/lib/media-posters";
import "./media.css";

const KINDS = { movie: "电影", show: "剧集", episode: "单集" };
const STATUSES = { wanted: "想看", watching: "在看", watched: "看过", unclassified: "未分类" };
const GENRES: Record<string, string> = { drama: "剧情", comedy: "喜剧", action: "动作", adventure: "冒险", animation: "动画", crime: "犯罪", documentary: "纪录片", family: "家庭", fantasy: "奇幻", history: "历史", horror: "恐怖", music: "音乐", mystery: "悬疑", romance: "爱情", "science-fiction": "科幻", "sci-fi": "科幻", thriller: "惊悚", war: "战争", western: "西部" };
function watchDay(value: string) { return value.length === 10 ? value : chinaToday(new Date(value)); }
function watchTime(value: string) { return Date.parse(value.length === 10 ? `${value}T12:00:00+08:00` : value); }
function dateLabel(value: string) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value.length === 10 ? `${value}T12:00:00+08:00` : value)); }

type Draft = { original?: MediaEntry; title: string; kind: "movie" | "show" | "episode"; status: MediaEntry["status"]; year: string; rating: string; watchedAt: string; thought: string };
export default function MediaPanel({ library, onChange, onRemember, trakt }: { library: MediaLibrary; trakt: TraktController; onChange: (next: MediaLibrary) => Promise<void>; onRemember: (entry: MediaEntry) => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
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
  const fileRef = useRef<HTMLInputElement>(null);
  const entries = library.entries;
  const titles = new Map(entries.map(entry => [entry.id, entry.title]));
  const history = entries.flatMap(entry => entry.history.map(event => ({ ...event, entry })));
  const years = [...new Set(history.map(event => watchDay(event.watchedAt).slice(0, 4)))].sort().reverse();
  const year = years.includes(yearChoice) ? yearChoice : years[0] ?? chinaToday().slice(0, 4);
  const yearHistory = history.filter(event => watchDay(event.watchedAt).startsWith(year));
  const months = Array.from({ length: 12 }, (_, index) => yearHistory.filter(event => Number(watchDay(event.watchedAt).slice(5, 7)) === index + 1).length);
  const rated = entries.filter(entry => entry.rating !== undefined);
  const showsSeen = new Set(entries.filter(entry => entry.kind === "show" && (entry.status === "watched" || entry.history.length > 0)).map(entry => entry.id));
  entries.filter(entry => entry.kind === "episode" && entry.history.length > 0).forEach(entry => showsSeen.add(entry.showId!));
  const visible = entries.filter(entry => kind === "all" || entry.kind === kind).filter(entry => status === "all" || entry.status === status).filter(entry => `${entry.title} ${entry.showId ? titles.get(entry.showId) ?? "" : ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const current = visible.find(entry => entry.id === selected) ?? visible[0];
  const preferences = new Map<string, number>();
  entries.filter(entry => entry.kind !== "episode" && (entry.history.length > 0 || entry.status === "watched" || showsSeen.has(entry.id))).forEach(entry => entry.genres.forEach(genre => preferences.set(genre, (preferences.get(genre) ?? 0) + 1)));
  const genres = [...preferences].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const recent = [...history].sort((a, b) => watchTime(b.watchedAt) - watchTime(a.watchedAt)).slice(0, 8);

  async function run(action: () => Promise<void>, note: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); setMessage(note); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存没有完成，请重试。草稿仍在这里。"); }
    finally { setBusy(false); }
  }
  function edit(entry?: MediaEntry) {
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
    await run(async () => { await onChange({ ...library, entries: entries.some(entry => entry.id === parsed.data.id) ? entries.map(entry => entry.id === parsed.data.id ? parsed.data : entry) : [...entries, parsed.data] }); setSelected(parsed.data.id); setDraft(null); }, "影音记录已保存。");
  }
  function previewJson() { try { setPreview(parseMediaImport(json)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "资料格式无法读取。"); } }
  async function retryPosters() {
    if (posterRetrying) return;
    const urls = [...new Set([...document.querySelectorAll<HTMLElement>("[data-poster-failed]")].map(element => element.dataset.posterFailed).filter((url): url is string => Boolean(url)))];
    if (!urls.length) { setMessage("没有加载失败的海报。缺少海报地址时，可在 Trakt 连接处更新资料。"); return; }
    setPosterRetrying(true);
    try { await Promise.all(urls.map(async url => { await invalidateMediaPoster(url); await invalidatePosterWorker(url); })); setPosterEpoch(value => value + 1); setMessage("正在重新加载失败的海报。"); }
    catch { setError("海报缓存暂时无法更新，请稍后重试。"); }
    finally { setPosterRetrying(false); }
  }
  function exportJson() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `有序-影音-${chinaToday()}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <section className="media-panel" aria-labelledby="media-heading">
    <header className="media-header"><div><p className="eyebrow">VIEWING JOURNAL</p><h1 id="media-heading">看过的世界，留在生活里。</h1><p>电影、剧集、重看的夜晚，以及故事留下的感受。</p></div><div className="media-actions"><button type="button" className="button secondary" onClick={() => { setImporting(!importing); setDraft(null); setPreview(null); }} disabled={busy}>导入影音 JSON</button><button type="button" className="button primary" onClick={() => edit()} disabled={busy}>记一部作品</button></div></header>
    {error && <p className="media-error" role="alert">{error}</p>}{message && <p className="media-message" role="status">{message}</p>}
    <div className="media-overview" aria-label="影音概览"><article><span>看过电影</span><strong>{entries.filter(entry => entry.kind === "movie" && (entry.status === "watched" || entry.history.length > 0)).length}<small>部</small></strong></article><article><span>剧集足迹</span><strong>{showsSeen.size}<small>部</small></strong></article><article><span>有日期的观看</span><strong>{history.length}<small>次</small></strong></article><article><span>我的平均评分</span><strong>{rated.length ? (rated.reduce((sum, entry) => sum + entry.rating!, 0) / rated.length).toFixed(1) : "—"}<small>/ 10</small></strong></article></div>
    <div className="media-insights"><section className="media-card"><header><h2>这一年的影音足迹</h2><label><span className="media-sr-only">影音回顾年份</span><select aria-label="影音回顾年份" value={year} onChange={event => setYearChoice(event.target.value)}>{(years.length ? years : [year]).map(value => <option key={value} value={value}>{value} 年</option>)}</select></label></header><p>{yearHistory.length} 次有日期的观看 · 按明确提供的观看记录统计</p><div className="media-months" role="img" aria-label={`${year}年各月观看次数：${months.map((count, index) => `${index + 1}月${count}次`).join("，")}`}>{months.map((count, index) => <div key={index} title={`${year}年${index + 1}月：${count}次`}><span>{count || ""}</span><i style={{ height: `${count ? Math.max(5, count / Math.max(...months, 1) * 88) : 2}px` }}/><small>{index + 1}月</small></div>)}</div><p className="media-muted">没有观看日期的作品保留在片单中，不计入月份。</p></section><section className="media-card"><h2>故事的偏好</h2>{genres.length ? <ul className="media-genres">{genres.map(([genre, count]) => <li key={genre}><span>{GENRES[genre] ?? genre}</span><meter min={0} max={Math.max(...genres.map(item => item[1]))} value={count}/><small>{count} 部</small></li>)}</ul> : <p className="media-muted">有观看和类型资料后，会在这里显示常看的题材。</p>}<p className="media-muted">基于已有作品类型，供回顾自己；不是人格或成长评分。</p></section></div>
    {draft && <form className="media-card media-editor" onSubmit={event => void save(event)} aria-label="影音记录表单"><header><h2>{draft.original ? "编辑影音记录" : "留下一部作品"}</h2><button type="button" className="text-button" disabled={busy} onClick={() => setDraft(null)}>取消</button></header><fieldset disabled={busy} className="media-form-grid"><label className="field media-full">片名<input required maxLength={500} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label><label className="field">作品类型<select disabled={Boolean(draft.original)} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as Draft["kind"] })}>{Object.entries(KINDS).filter(([value]) => value !== "episode" || draft.original?.kind === "episode").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">观看状态<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as Draft["status"] })}>{Object.entries(STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">上映年份<input type="number" min={1880} max={2200} value={draft.year} onChange={event => setDraft({ ...draft, year: event.target.value })}/></label><label className="field">我的评分<input type="number" min={0} max={10} step={0.5} value={draft.rating} onChange={event => setDraft({ ...draft, rating: event.target.value })} placeholder="0—10，可留空"/></label><label className="field media-full">追加一次观看日期<input type="date" max={chinaToday()} value={draft.watchedAt} onChange={event => setDraft({ ...draft, watchedAt: event.target.value })}/><span>可留空；只标记“看过”不会生成观看次数。</span></label><label className="field media-full">我的感想<textarea rows={4} maxLength={20000} value={draft.thought} onChange={event => setDraft({ ...draft, thought: event.target.value })} placeholder="这个故事碰到了你生活里的什么？"/></label></fieldset><button type="submit" className="button primary" disabled={busy}>{busy ? "正在保存…" : "保存影音记录"}</button></form>}
    {importing && <section className="media-card media-editor"><h2>导入影音资料</h2><input type="file" accept="application/json,.json" ref={fileRef} aria-label="选择影音 JSON 文件" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > MAX_MEDIA_IMPORT_BYTES) { setError("影音文件过大，最多 5 MB。"); return; } try { setJson(await file.text()); setPreview(null); setError(""); } catch { setError("文件读取没有完成，请重新选择文件。"); } }}/><label className="field">影音资料 JSON<textarea rows={8} value={json} onChange={event => { setJson(event.target.value); setPreview(null); }}/></label><button type="button" className="button secondary" disabled={busy || !json.trim()} onClick={previewJson}>预览影音资料</button>{preview && <div className="media-import-preview"><p>本次导入 {preview.entries.length} 个作品条目、{preview.entries.reduce((sum, entry) => sum + entry.history.length, 0)} 次有日期的观看。</p><button type="button" className="button primary" disabled={busy} onClick={() => void run(async () => { await onChange(mergeMediaLibraries(library, preview)); setPreview(null); setImporting(false); }, "影音资料已合并。")}>确认导入影音</button></div>}</section>}
    <div className="media-library-layout"><section className="media-card"><header><h2>我的片单 <span className="count-pill">{visible.length}</span></h2><div className="media-actions"><button type="button" className="text-button" disabled={posterRetrying} onClick={() => void retryPosters()}>{posterRetrying ? "正在重试…" : "重试失败海报"}</button><button type="button" className="text-button" onClick={exportJson}>导出影音</button></div></header><div className="media-filters"><label className="media-search"><span className="media-sr-only">搜索影音</span><input placeholder="搜索电影、剧集" aria-label="搜索影音" value={search} onChange={event => setSearch(event.target.value)}/></label><select aria-label="筛选影音类型" value={kind} onChange={event => setKind(event.target.value)}><option value="all">所有类型</option>{Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="筛选观看状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">所有状态</option>{Object.entries(STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>{visible.length ? <div className="media-titles">{visible.slice(0, 100).map(entry => <button type="button" className={`media-title ${current?.id === entry.id ? "selected" : ""}`} aria-pressed={current?.id === entry.id} key={entry.id} onClick={() => setSelected(entry.id)}><MediaPoster key={`${entry.id}:${posterEpoch}`} url={entry.poster} title={entry.title} kind={entry.kind}/><span><strong>{entry.title}</strong><small>{entry.year ?? "年份未提供"}{entry.kind === "episode" ? ` · S${entry.season} E${entry.episode}` : ""}</small><em>{STATUSES[entry.status]}{entry.rating !== undefined ? ` · 我的评分 ${entry.rating}/10` : ""}</em></span></button>)}{visible.length > 100 && <p className="media-muted">先展示前 100 项，可通过搜索和筛选查找其余作品。</p>}</div> : <div className="media-empty"><span aria-hidden="true">▷</span><h3>{entries.length ? "没有符合条件的作品" : "留住故事，也留住当时的自己。"}</h3><p>可以先记一部作品，也可以连接 Trakt 带回自己的观影记录。</p></div>}</section><aside className="media-card media-detail" aria-label="影音详情">{current ? <><p className="eyebrow">{KINDS[current.kind]}</p>{current.poster && <div className="media-detail-poster"><MediaPoster key={`${current.id}:${posterEpoch}`} url={current.poster} title={current.title} kind={current.kind}/></div>}<h2>{current.title}</h2>{current.showId && <p>{titles.get(current.showId)} · 第 {current.season} 季第 {current.episode} 集</p>}<p>{STATUSES[current.status]}{current.year ? ` · ${current.year} 年` : ""}</p>{current.rating !== undefined && <p className="media-own-rating">我的评分 <strong>{current.rating}</strong> / 10</p>}<p className="media-muted">{current.history.length} 次有日期的观看记录</p>{current.history.length > 0 && <ul className="media-history">{[...current.history].sort((a, b) => watchTime(b.watchedAt) - watchTime(a.watchedAt)).map(event => <li key={event.id}><time dateTime={event.watchedAt}>{dateLabel(event.watchedAt)}</time></li>)}</ul>}{current.thought && <blockquote className="media-thought">{current.thought}</blockquote>}<div className="media-actions"><button type="button" className="button secondary" onClick={() => edit(current)} disabled={busy}>编辑记录与感想</button><button type="button" className="text-button" disabled={busy || (!current.thought?.trim() && current.history.length === 0 && current.status !== "watched")} onClick={() => void run(() => onRemember(current), "这份影音感受已留在人生看板。")}>留在人生看板</button></div>{current.traktUrl && <a href={current.traktUrl} target="_blank" rel="noopener noreferrer">在 Trakt 查看作品 ↗</a>}</> : <><h2>故事之外，是你的生活。</h2><p className="media-muted">选择一部作品，回看观看日期、自己的评分和留下的感想。</p></>}</aside></div>
    {recent.length > 0 && <section className="media-card media-recent"><h2>最近看过的故事</h2><ol>{recent.map(event => <li key={event.id}><time dateTime={event.watchedAt}>{dateLabel(event.watchedAt)}</time><span>{event.entry.title}</span><small>{KINDS[event.entry.kind]}</small></li>)}</ol></section>}
    {entries.some(entry => entry.traktId && entry.kind !== "episode" && !entry.poster) && <p className="media-muted">部分记录没有海报地址。连接 Trakt 并保存后，会随每次打开网页补充官方提供的海报信息；已连接也可点击「立即更新」。原有感想和观看记录会保留。</p>}
    <TraktSync connection={trakt}/>
  </section>;
}
