import type { ReadingBook, ReadingHighlight, ReadingLibrary } from "./reading";

export type ReadingRevisitFilter = "all" | "highlights" | "thoughts";
export type ReadingRevisitItem = { book: ReadingBook; note: ReadingHighlight };
export type ReadingRevisitSelection = { currentId: string | null; seen: string[] };

/** Use saved text and its actual source; no invented excerpts or unrelated books. */
export function readingRevisitItems(library: ReadingLibrary): ReadingRevisitItem[] {
  const books = new Map(library.books.map(book => [book.id, book]));
  return library.highlights.flatMap(note => {
    const book = books.get(note.bookId);
    return book && (note.text.trim() || note.thought?.trim()) ? [{ book, note }] : [];
  });
}

export function filterReadingRevisit(items: ReadingRevisitItem[], filter: ReadingRevisitFilter): ReadingRevisitItem[] {
  return items.filter(({ note }) => filter === "highlights" ? Boolean(note.text.trim())
    : filter === "thoughts" ? Boolean(note.thought?.trim()) : true);
}

/** Finish one round before repeating; avoid adjacent repeats across rounds. */
export function nextReadingRevisit(ids: string[], previous: ReadingRevisitSelection, random = Math.random): ReadingRevisitSelection {
  if (!ids.length) return { currentId: null, seen: [] };
  const valid = new Set(ids);
  const seen = previous.seen.filter(id => valid.has(id));
  const used = new Set(seen);
  const remaining = ids.filter(id => !used.has(id));
  const freshRound = !remaining.length;
  const choices = freshRound ? ids.filter(id => id !== previous.currentId) : remaining;
  const pool = choices.length ? choices : ids;
  const value = random();
  const sample = Number.isFinite(value) ? Math.min(1 - Number.EPSILON, Math.max(0, value)) : 0;
  const currentId = pool[Math.floor(sample * pool.length)];
  return { currentId, seen: [...(freshRound ? [] : seen), currentId] };
}
