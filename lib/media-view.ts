import { normalizeMediaPoster } from "./media";
import type { MediaEntry } from "./media";

export type MediaWork = {
  entry: MediaEntry;
  episodes: MediaEntry[];
  history: { id: string; watchedAt: string; entry: MediaEntry }[];
  firstWatchedAt?: string;
  lastWatchedAt?: string;
  watchedEpisodeCount: number;
  thoughts: MediaEntry[];
};

const viewingDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

/** A supplied calendar date remains a date; timestamps use the review's local day. */
export function viewingDay(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = viewingDayFormatter.formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Historical episode events do not establish the show's present viewing state. */
export function workStatus(work: MediaWork): MediaEntry["status"] {
  return work.entry.status;
}

export function mediaWorkCount(entries: readonly MediaEntry[]): number {
  return new Set(entries.flatMap(entry => entry.kind === "episode" ? entry.showId ? [entry.showId] : [] : [entry.id])).size;
}

/** Build work-sized review cards without changing any stored record. */
export function buildMediaWorks(entries: readonly MediaEntry[]): MediaWork[] {
  const episodesByShow = new Map<string, MediaEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "episode" || !entry.showId) continue;
    const episodes = episodesByShow.get(entry.showId) ?? [];
    episodes.push(entry);
    episodesByShow.set(entry.showId, episodes);
  }
  const works = entries.filter(entry => entry.kind !== "episode");
  const showIds = new Set(works.filter(entry => entry.kind === "show").map(entry => entry.id));
  for (const [showId, episodes] of episodesByShow) {
    if (showIds.has(showId)) continue;
    const poster = episodes.map(episode => normalizeMediaPoster(episode.poster)).find(Boolean);
    works.push({
      id: showId, kind: "show", title: "未命名剧集", status: "unclassified", history: [],
      genres: [...new Set(episodes.flatMap(episode => episode.genres))],
      ...(poster ? { poster } : {}),
    });
  }
  return works.map(entry => {
    const episodes = entry.kind === "show" ? [...(episodesByShow.get(entry.id) ?? [])].sort((a, b) =>
      (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.id.localeCompare(b.id)) : [];
    const members = [entry, ...episodes];
    const history = members.flatMap(member => member.history.map(event => ({ ...event, entry: member })))
      .sort((a, b) => Date.parse(b.watchedAt) - Date.parse(a.watchedAt) || a.id.localeCompare(b.id));
    return {
      entry, episodes, history,
      ...(history.length ? {
        firstWatchedAt: history[history.length - 1].watchedAt,
        lastWatchedAt: history[0].watchedAt,
      } : {}),
      watchedEpisodeCount: new Set(episodes.filter(episode => episode.history.length > 0).map(episode => episode.id)).size,
      thoughts: members.filter(member => Boolean(member.thought?.trim())),
    };
  });
}
