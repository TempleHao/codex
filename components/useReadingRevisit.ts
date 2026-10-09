"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReadingLibrary } from "@/lib/reading";
import { filterReadingRevisit, nextReadingRevisit, readingRevisitItems, type ReadingRevisitFilter, type ReadingRevisitSelection } from "@/lib/reading-revisit";

export function useReadingRevisit(library: ReadingLibrary, ready: boolean) {
  const [filter, setFilter] = useState<ReadingRevisitFilter>("all");
  const [selection, setSelection] = useState<ReadingRevisitSelection>({ currentId: null, seen: [] });
  const items = useMemo(() => readingRevisitItems(library), [library.books, library.highlights]);
  const candidates = useMemo(() => filterReadingRevisit(items, filter), [items, filter]);
  const ids = useMemo(() => candidates.map(item => item.note.id), [candidates]);
  useEffect(() => {
    if (!ready) return;
    setSelection(previous => {
      if (previous.currentId && ids.includes(previous.currentId)) return previous;
      if (!ids.length && !previous.currentId && !previous.seen.length) return previous;
      return nextReadingRevisit(ids, previous);
    });
  }, [ids, ready]);

  function changeFilter(next: ReadingRevisitFilter) {
    if (filter === next) return;
    setFilter(next);
    setSelection({ currentId: null, seen: [] });
  }
  return {
    filter, changeFilter, total: items.length, count: candidates.length,
    current: candidates.find(item => item.note.id === selection.currentId) ?? null,
    next: () => setSelection(previous => nextReadingRevisit(ids, previous)),
  };
}
export type ReadingRevisitController = ReturnType<typeof useReadingRevisit>;
