"use client";

import { useId, useMemo, useState } from "react";
import { chinaToday } from "@/lib/dates";
import type { ReadingLibrary } from "@/lib/reading";
import type { MediaLibrary } from "@/lib/media";
import { buildMediaWorks, viewingDay } from "@/lib/media-view";
import type { LifeThought } from "@/lib/life";
import type { BlogArchive } from "@/lib/blog";
import { summarizeFinance, transactionFlow, createFinanceContext, type FinanceLibrary } from "@/lib/finance";
import "./life-overview.css";

export interface LifeOverviewProps {
  reading: ReadingLibrary;
  media: MediaLibrary;
  thoughts: LifeThought[];
  blog?: BlogArchive;
  finance: FinanceLibrary;
  onOpenReading: () => void;
  onOpenMedia: () => void;
  onOpenThoughts: () => void;
  onOpenFinance: () => void;
}
type Source = "reading" | "media" | "thoughts" | "finance";
type RecordItem = { id: string; source: Source; date: string; title: string; detail: string };
const labels: Record<Source, string> = { reading: "阅读", media: "影音", thoughts: "思考", finance: "财务" };
const money = (cents: number) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);
const excerpt = (text: string) => {
  const plain = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > 82 ? `${chars.slice(0, 82).join("")}…` : plain;
};
function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (!minutes && seconds > 0) return "不到 1 分钟";
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}` : `${minutes} 分钟`;
}
function OverviewIcon({ source }: { source: Source }) {
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {source === "reading" && <><path d="M12 5v15M3 4c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1Z" /></>}
    {source === "media" && <><rect x="3" y="4" width="18" height="14" rx="3" /><path d="m10 8 5 3-5 3ZM8 21h8" /></>}
    {source === "thoughts" && <><path d="M6 4h9l3 3v14H6ZM14 4v5h5M9 12h6M9 16h4" /></>}
    {source === "finance" && <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="m9 7 3 4 3-4M9 12h6M9 15h6M12 11v7" /></>}
  </svg>;
}

export default function LifeOverview({ reading, media, thoughts, blog, finance, onOpenReading, onOpenMedia, onOpenThoughts, onOpenFinance }: LifeOverviewProps) {
  const [month, setMonth] = useState(() => chinaToday().slice(0, 7));
  const id = useId();
  const data = useMemo(() => {
    const works = buildMediaWorks(media.entries);
    const blogEntries = blog?.entries ?? [];
    const dayMatches = (date: string) => Boolean(date) && (!month || date.startsWith(month));
    const readingDays = (reading.stats?.dailySeconds ?? []).filter(day => dayMatches(day.date) && day.seconds > 0);
    const notes = reading.highlights.filter(note => note.createdAt && dayMatches(viewingDay(note.createdAt)));
    const viewed = works.map(work => ({ work, events: work.history.filter(event => dayMatches(viewingDay(event.watchedAt))) })).filter(item => item.events.length);
    const localText = thoughts.filter(thought => dayMatches(viewingDay(thought.createdAt)));
    const blogText = blogEntries.filter(entry => dayMatches(viewingDay(entry.date)));
    const financeRows = finance.transactions.filter(row => dayMatches(row.occurredAt.slice(0, 10)));
    const financeContext = createFinanceContext(finance.transactions);
    const financeSummary = summarizeFinance(financeRows, financeContext);
    const booksById = new Map(reading.books.map(book => [book.id, book]));
    const readingRecords: RecordItem[] = [
      ...notes.map(note => ({ id: `reading:${note.id}`, source: "reading" as const, date: viewingDay(note.createdAt!), title: booksById.get(note.bookId)?.title ?? "", detail: excerpt(note.thought?.trim() || note.text) })),
      ...readingDays.map(day => ({ id: `reading-day:${day.date}`, source: "reading" as const, date: day.date, title: "", detail: `这天阅读了 ${duration(day.seconds)}` })),
    ];
    const mediaRecords: RecordItem[] = viewed.map(({ work, events }) => {
      const date = events.map(event => viewingDay(event.watchedAt)).sort().at(-1)!;
      const title = work.entry.title === "未命名剧集" && !media.entries.some(entry => entry.id === work.entry.id) ? "" : work.entry.title;
      return { id: `media:${work.entry.id}`, source: "media", date, title, detail: `${work.entry.kind === "movie" ? "电影" : "剧集"} · ${new Set(events.map(event => viewingDay(event.watchedAt))).size} 天留下观看记录` };
    });
    const textRecords: RecordItem[] = [
      ...localText.map(thought => ({ id: `thought:${thought.id}`, source: "thoughts" as const, date: viewingDay(thought.createdAt), title: thought.title, detail: excerpt(thought.body) })),
      ...blogText.map(entry => ({ id: `blog:${entry.id}`, source: "thoughts" as const, date: viewingDay(entry.date), title: excerpt(entry.title), detail: `${excerpt(entry.text) || (entry.images.length ? `${entry.images.length} 张图片` : entry.media.length ? "留下了影音内容" : "文字记录")} · 博客` })),
    ];
    const spendDays = new Map<string, { cents: number; count: number }>();
    for (const row of financeRows) if (transactionFlow(row, financeContext) === "expense") {
      const date = row.occurredAt.slice(0, 10);
      const day = spendDays.get(date) ?? { cents: 0, count: 0 };
      day.cents += row.amountCents; day.count += 1; spendDays.set(date, day);
    }
    const financeRecords: RecordItem[] = [...spendDays].map(([date, day]) => ({ id: `finance:${date}`, source: "finance", date, title: "", detail: `${day.count} 笔已支付支出 · ${money(day.cents)}` }));
    const recent = [readingRecords, mediaRecords, textRecords, financeRecords].flatMap(records => records.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, 2)).sort((a, b) => b.date.localeCompare(a.date) || a.source.localeCompare(b.source));
    const dates = [
      ...reading.highlights.flatMap(note => note.createdAt ? [viewingDay(note.createdAt)] : []),
      ...(reading.stats?.dailySeconds ?? []).map(day => day.date),
      ...works.flatMap(work => work.history.map(event => viewingDay(event.watchedAt))),
      ...thoughts.map(thought => viewingDay(thought.createdAt)), ...blogEntries.map(entry => viewingDay(entry.date)),
      ...finance.transactions.map(row => row.occurredAt.slice(0, 10)),
    ];
    const months = [...new Set([chinaToday().slice(0, 7), ...dates.filter(Boolean).map(date => date.slice(0, 7))])].sort().reverse();
    return { works, blogEntries, readingDays, notes, viewed, localText, blogText, financeSummary, recent, months };
  }, [reading, media, thoughts, blog, finance, month]);
  const open: Record<Source, () => void> = { reading: onOpenReading, media: onOpenMedia, thoughts: onOpenThoughts, finance: onOpenFinance };
  const period = month ? `${Number(month.slice(5))} 月` : "全部记录";
  const modules: { source: Source; count: number; unit: string; cumulative: string; activity: string; empty: string }[] = [
    { source: "reading", count: reading.books.length, unit: "本", cumulative: `${reading.highlights.length} 条阅读笔记`, activity: data.readingDays.length ? `${period} · 阅读 ${duration(data.readingDays.reduce((sum, day) => sum + day.seconds, 0))}，${data.readingDays.length} 天` : data.notes.length ? `${period} · 留下 ${data.notes.length} 条笔记` : `${period} · 暂无带日期的阅读记录`, empty: "读过的书与喜欢的句子，可以慢慢留在这里。" },
    { source: "media", count: data.works.length, unit: "部", cumulative: "以整部作品整理片单", activity: data.viewed.length ? `${period} · 有 ${data.viewed.length} 部作品的观看记录` : `${period} · 暂无带日期的观看记录`, empty: "把电影与剧集留下，记得那些故事。" },
    { source: "thoughts", count: thoughts.length + data.blogEntries.length, unit: "篇", cumulative: `本机 ${thoughts.length} 篇 · 博客 ${data.blogEntries.length} 篇`, activity: data.localText.length + data.blogText.length ? `${period} · 留下 ${data.localText.length + data.blogText.length} 篇文字` : `${period} · 暂无文字记录`, empty: "有些想法不必成为任务，写下来就很好。" },
    { source: "finance", count: finance.transactions.length, unit: "笔", cumulative: "已保存的账单记录", activity: data.financeSummary.expenseCount ? `${period} · 已支付支出 ${money(data.financeSummary.expenseCents)}` : `${period} · 暂无已支付支出`, empty: "从一份账单开始，回看生活的花费。" },
  ];
  return <section className="life-overview" aria-labelledby={`${id}-title`}>
    <header className="life-overview-heading"><div><p className="life-overview-kicker">阅读 · 影音 · 思考 · 财务</p><h2 id={`${id}-title`}>生活总览</h2><p>汇集已经保存的记录，回看生活的不同部分。</p></div><label htmlFor={`${id}-month`}>回看时间<select id={`${id}-month`} value={month} onChange={event => setMonth(event.target.value)}><option value="">全部时间</option>{data.months.map(value => <option key={value} value={value}>{value.slice(0, 4)} 年 {Number(value.slice(5))} 月</option>)}</select></label></header>
    <div className="life-overview-modules">{modules.map(module => <button type="button" className={`life-overview-module life-overview-${module.source}`} key={module.source} onClick={open[module.source]} aria-label={`查看${labels[module.source]}记录`}>
      <span className="life-overview-module-top"><span className="life-overview-icon"><OverviewIcon source={module.source} /></span><span>{labels[module.source]}</span><span className="life-overview-arrow" aria-hidden="true">↗</span></span>
      <span className="life-overview-total"><strong>{module.count}</strong><span>{module.unit}<span className="life-overview-total-label">累计保存</span></span></span>
      <span className="life-overview-cumulative">{module.cumulative}</span><span className="life-overview-module-note">{module.count ? module.activity : module.empty}</span>
    </button>)}</div>
    <section className="life-overview-recent" aria-labelledby={`${id}-recent`}><div className="life-overview-recent-heading"><h3 id={`${id}-recent`}>最近留下的记录</h3><p>{month ? `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月` : "全部时间"} · 各领域的生活片段</p></div>
      {data.recent.length ? <div className="life-overview-records">{data.recent.map(record => <button type="button" className="life-overview-record" key={record.id} onClick={open[record.source]}><span className={`life-overview-record-source life-overview-${record.source}`}>{labels[record.source]}</span><span className="life-overview-record-content">{record.title && <strong>{record.title}</strong>}<span>{record.detail}</span></span><time dateTime={record.date}>{record.date}</time><span className="life-overview-record-arrow" aria-hidden="true">↗</span></button>)}</div> : <p className="life-overview-no-records">这段时间还没有带日期的记录。已有资料仍在上方，也可以换一个月份看看。</p>}
    </section>
  </section>;
}
