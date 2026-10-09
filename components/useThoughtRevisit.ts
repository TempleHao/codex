"use client";

import { useEffect, useMemo, useState } from "react";
import type { BlogArchive } from "@/lib/blog";
import type { LifeThought } from "@/lib/life";
import { nextReadingRevisit, type ReadingRevisitSelection } from "@/lib/reading-revisit";

export type ThoughtRevisitItem = { id: string; source: "local" | "blog"; title: string; text: string; date: string; sourceUrl?: string; author?: string };
export function thoughtRevisitItems(thoughts: LifeThought[], blog?: BlogArchive): ThoughtRevisitItem[] {
  return [
    ...thoughts.filter(thought => thought.body.trim()).map(thought => ({ id: thought.id, source: "local" as const, title: thought.title, text: thought.body, date: thought.createdAt })),
    ...(blog?.entries ?? []).filter(entry => entry.text.trim()).map(entry => ({ id: entry.id, source: "blog" as const, title: entry.title, text: entry.text, date: entry.date, sourceUrl: entry.sourceUrl, author: entry.author })),
  ];
}
/** Mount once in the page controller so navigation does not start a new round. */
export function useThoughtRevisit(thoughts: LifeThought[], blog?: BlogArchive, ready = true) {
  const [selection, setSelection] = useState<ReadingRevisitSelection>({ currentId: null, seen: [] });
  const items = useMemo(() => thoughtRevisitItems(thoughts, blog), [thoughts, blog?.entries]);
  const ids = useMemo(() => items.map(item => item.id), [items]);
  useEffect(() => {
    if (!ready) return;
    setSelection(previous => previous.currentId && ids.includes(previous.currentId) ? previous : nextReadingRevisit(ids, previous));
  }, [ids, ready]);
  return { current: items.find(item => item.id === selection.currentId) ?? null, count: items.length, total: items.length, next: () => setSelection(previous => nextReadingRevisit(ids, previous)) };
}
export type ThoughtRevisitController = ReturnType<typeof useThoughtRevisit>;
