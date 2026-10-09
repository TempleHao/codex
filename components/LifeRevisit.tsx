"use client";

import { useEffect, useState } from "react";
import ReadingRevisit, { type ReadingNoteRequest } from "./ReadingRevisit";
import ThoughtRevisit from "./ThoughtRevisit";
import type { ReadingRevisitController } from "./useReadingRevisit";
import type { ThoughtRevisitController } from "./useThoughtRevisit";

type Source = "reading" | "thoughts";
export function useLifeRevisitSelection(reading: ReadingRevisitController, thoughts: ThoughtRevisitController) {
  const [filter, setFilter] = useState<"all" | Source>("all");
  const [source, setSource] = useState<Source | null>(null);
  const available = [reading.total ? "reading" : null, thoughts.total ? "thoughts" : null].filter(Boolean) as Source[];
  useEffect(() => {
    setSource(current => {
      if (current && available.includes(current)) return current;
      if (filter !== "all") return available.includes(filter) ? filter : null;
      return available.length ? available[Math.floor(Math.random() * available.length)] : null;
    });
    // Preserve the current source while background updates add new entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading.total > 0, thoughts.total > 0, filter]);
  function next() {
    const candidates = filter === "all" ? available : available.filter(value => value === filter);
    let selected = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
    if (filter === "all" && selected === source && candidates.length > 1 && (selected === "reading" ? reading.count : thoughts.count) < 2) selected = candidates.find(value => value !== source)!;
    if (selected === "reading") reading.next();
    if (selected === "thoughts") thoughts.next();
    setSource(selected);
  }
  return { filter, source, available, next, changeFilter(value: "all" | Source) { setFilter(value); if (value !== "all") setSource(value); } };
}
export default function LifeRevisit({ reading, thoughts, selection, onOpenNote, onOpenThought }: {
  reading: ReadingRevisitController; thoughts: ThoughtRevisitController; selection: ReturnType<typeof useLifeRevisitSelection>;
  onOpenNote: (request: ReadingNoteRequest) => void; onOpenThought: (id: string) => void;
}) {
  const { filter, source, available, next, changeFilter } = selection;
  if (!available.length) return null;
  const count = filter === "all" ? reading.count + thoughts.count : filter === "reading" ? reading.count : thoughts.count;
  return <section className="reading-revisit life-revisit" aria-labelledby="life-revisit-title">
    <header className="revisit-heading"><div><p className="section-kicker">MEET YOUR WORDS AGAIN</p><h2 id="life-revisit-title">偶然重逢</h2><p>读过的句子，写下的感悟，今天再遇见。</p></div><div className="revisit-filters" role="group" aria-label="回顾来源">{([["all", "全部"], ["reading", "阅读"], ["thoughts", "思考"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => changeFilter(value)}>{label}</button>)}</div></header>
    {source === "reading" ? <ReadingRevisit controller={reading} onOpenNote={onOpenNote} embedded onNext={next}/> : source === "thoughts" ? <ThoughtRevisit controller={thoughts} onOpenThought={onOpenThought} embedded/> : <p className="revisit-no-results">这个来源还没有可回顾的内容。</p>}
    <div className="life-revisit-next"><button className="button secondary" type="button" onClick={next} disabled={!source || count < 2}>{count === 1 ? "只有这一条" : "换一条"}</button></div>
  </section>;
}
