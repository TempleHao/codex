"use client";

import { useId, useState } from "react";
import type { ThoughtRevisitController, ThoughtRevisitItem } from "./useThoughtRevisit";
import "./reading-revisit.css";
import "./thoughts.css";

function RevisitText({ item }: { item: ThoughtRevisitItem }) {
  const [expanded, setExpanded] = useState(false);
  const characters = Array.from(item.text.trim());
  const long = characters.length > 280;
  return <><p className="revisit-kind">{item.source === "blog" ? "博客里的旧文字" : "当时写下的想法"}</p><blockquote className="revisit-thought">{expanded || !long ? item.text : `${characters.slice(0, 280).join("")}…`}</blockquote>{long && <button className="text-button revisit-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起全文" : "展开全文"}</button>}</>;
}
export default function ThoughtRevisit({ controller, onOpenThought, hideWhenEmpty = false, embedded = false }: {
  controller: ThoughtRevisitController; onOpenThought: (id: string) => void; hideWhenEmpty?: boolean; embedded?: boolean;
}) {
  const heading = useId();
  const { current, count, next } = controller;
  if (!count && hideWhenEmpty) return null;
  if (!count) return <aside className="reading-revisit-empty" aria-label="思考回顾提示"><strong>让过去的想法，偶然回来。</strong><p>写下一条思考，或等待博客同步后，就可以随机重读。</p></aside>;
  const date = current && new Date(current.date);
  const source = current?.sourceUrl && /^https?:\/\//.test(current.sourceUrl) ? current.sourceUrl : undefined;
  return <section className={embedded ? "thought-revisit-embedded" : "reading-revisit thought-revisit"} aria-label={embedded ? "思考回顾" : undefined} aria-labelledby={embedded ? undefined : heading}>
    {!embedded && <header className="revisit-heading"><div><p className="section-kicker">MEET YOUR WORDS AGAIN</p><h2 id={heading}>偶然重逢</h2><p>以前写下的一句话，今天可能有新的感受。</p></div></header>}
    <div className="revisit-content" aria-live="polite">{current ? <><RevisitText key={current.id} item={current}/><div className="revisit-source">{current.title.trim() && <strong>{current.title}</strong>}<span>{current.source === "blog" ? `博客 · ${current.author || "AshSilent"}` : "随手写"}</span>{date && !Number.isNaN(date.getTime()) && <time dateTime={current.date}>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(date)} 留下</time>}</div></> : <p>正在带回一段文字…</p>}</div>
    <footer className="revisit-footer"><span>{count} 条思考可回看</span><div>{source && <a className="text-button" href={source} target="_blank" rel="noopener noreferrer">原文 ↗</a>}{current && <button className="text-button" type="button" onClick={() => onOpenThought(current.id)}>在思考中查看</button>}{!embedded && <button type="button" className="button secondary" onClick={next} disabled={!current || count < 2}>{count === 1 ? "只有这一条" : "换一条"}</button>}</div></footer>
  </section>;
}
