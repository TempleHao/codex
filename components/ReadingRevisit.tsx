"use client";

import { useState } from "react";
import type { ReadingRevisitFilter, ReadingRevisitItem } from "@/lib/reading-revisit";
import type { ReadingRevisitController } from "./useReadingRevisit";
import "./reading-revisit.css";

export type ReadingNoteRequest = { bookId: string; noteId: string; tab: "highlights" | "thoughts"; requestId: string };
const FILTERS: [ReadingRevisitFilter, string][] = [["all", "都看看"], ["highlights", "划线"], ["thoughts", "我的想法"]];

function noteDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(date);
}

function RevisitText({ item, thought }: { item: ReadingRevisitItem; thought: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const text = (thought ? item.note.thought! : item.note.text).trim();
  const characters = Array.from(text);
  const long = characters.length > 280;
  return <>
    <p className="revisit-kind">{thought ? "当时的想法" : "划线原文"}</p>
    <blockquote className={thought ? "revisit-thought" : "revisit-quote"}>{expanded || !long ? text : `${characters.slice(0, 280).join("")}…`}</blockquote>
    {long && <button type="button" className="text-button revisit-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起全文" : "展开全文"}</button>}
    {thought && item.note.text.trim() && <details className="revisit-excerpt"><summary>回看当时的划线</summary><blockquote>{item.note.text}</blockquote></details>}
  </>;
}

export default function ReadingRevisit({ controller, onOpenNote, hideWhenEmpty = false, embedded = false, onNext }: {
  controller: ReadingRevisitController;
  onOpenNote: (request: ReadingNoteRequest) => void;
  hideWhenEmpty?: boolean;
  embedded?: boolean;
  onNext?: () => void;
}) {
  const { current, filter, total, count, changeFilter, next } = controller;
  if (!total && hideWhenEmpty) return null;
  if (!total) return <aside className="reading-revisit-empty" aria-label="阅读回顾提示"><strong>让读过的句子，偶然回来。</strong><p>保存划线或自己的想法后，这里会随机带回一条。微信读书需要在同步工作流中勾选笔记，再解锁并保存到阅读；也可以导入阅读 JSON。</p></aside>;
  const thought = Boolean(current?.note.thought?.trim()) && filter !== "highlights";
  const date = noteDate(current?.note.createdAt);
  return <section className={embedded ? "reading-revisit revisit-embedded" : "reading-revisit"} aria-label={embedded ? "阅读回顾" : undefined} aria-labelledby={embedded ? undefined : "reading-revisit-title"}>
    {!embedded && <header className="revisit-heading"><div><p className="section-kicker">MEET YOUR WORDS AGAIN</p><h2 id="reading-revisit-title">偶然重逢</h2><p>一段曾经触动你的文字，今天再读一次。</p></div><div className="revisit-filters" role="group" aria-label="回顾内容">{FILTERS.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => changeFilter(value)}>{label}</button>)}</div></header>}
    {embedded && <div className="life-revisit-note-filters"><span className="life-revisit-filter-label">笔记类型</span><div className="revisit-filters embedded-revisit-filters" role="group" aria-label="回顾内容">{FILTERS.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => changeFilter(value)}>{label}</button>)}</div></div>}
    <div className="revisit-content" aria-live="polite">
      {current ? <>
        <RevisitText key={`${current.note.id}:${thought}`} item={current} thought={thought}/>
        <div className="revisit-source"><strong>《{current.book.title}》</strong>{current.book.author && <span>{current.book.author}</span>}{current.note.chapter?.trim() && <span>{current.note.chapter}</span>}{date && <time dateTime={current.note.createdAt}>{date} 留下</time>}</div>
      </> : <p className="revisit-no-results">{count ? "正在带回一段文字…" : filter === "thoughts" ? "还没有保存自己的想法，可以先回看划线。" : "还没有保存划线原文，可以先看看自己的想法。"}</p>}
    </div>
    <footer className="revisit-footer"><span>来自已保存的阅读笔记 · {count} 条可回看</span><div>{current && <button type="button" className="text-button" onClick={() => onOpenNote({ bookId: current.book.id, noteId: current.note.id, tab: thought ? "thoughts" : "highlights", requestId: crypto.randomUUID() })}>查看这条笔记</button>}{!onNext && <button type="button" className="button secondary" onClick={next} disabled={!current || count < 2}>{count === 1 ? "只有这一条" : "换一条"}</button>}</div></footer>
  </section>;
}
