import { z } from "zod";
import { MAX_MEDIA_IMPORT_BYTES, mediaLibrarySchema, traktMediaId, type MediaEntry, type MediaLibrary } from "./media";

export const TRAKT_AUTH_CONTEXT_KEY = "life-workbench:trakt-pkce";
// This is our local sign-in window, not a documented Trakt authorization-code lifetime.
export const TRAKT_LOCAL_AUTH_MAX_AGE_MS = 10 * 60 * 1_000;
const AUTHORITY = "https://auth.trakt.tv";
const API_ORIGIN = "https://api.trakt.tv";
const PAGE_SIZE = 250;
const DATA_ERROR = "Trakt 返回的数据不完整，本次未导入。请稍后重试。";
const AUTH_ERROR = "临时授权信息无效或已过期，请重新连接 Trakt。";
const CLIENT_ERROR = "请填写有效的 Trakt Client ID，并配置本站的 HTTPS 回调地址。";

export class TraktError extends Error {
  constructor(message: string) { super(message); this.name = "TraktError"; }
}

export interface TraktAuthorizationContext {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}
export type TraktTemporaryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface TraktRequestOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

const clientIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const verifierSchema = z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/);
const stateSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const tokenSchema = z.string().min(1).max(4_096).regex(/^\S+$/);
const redirectSchema = z.string().max(2_000).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.href === value;
  } catch { return false; }
});
const contextSchema = z.object({
  state: stateSchema, verifier: verifierSchema, clientId: clientIdSchema, redirectUri: redirectSchema,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function traktPkceChallenge(verifier: string, cryptoProvider: Crypto = globalThis.crypto): Promise<string> {
  if (!verifierSchema.safeParse(verifier).success) throw new TraktError(AUTH_ERROR);
  try {
    return base64url(new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  } catch { throw new TraktError("浏览器无法创建安全授权，请使用支持 HTTPS 的现代浏览器。"); }
}

export async function createTraktAuthorization(
  clientId: string,
  redirectUri: string,
  options: { now?: number; crypto?: Crypto } = {},
): Promise<{ context: TraktAuthorizationContext; authorizeUrl: string }> {
  if (!clientIdSchema.safeParse(clientId).success || !redirectSchema.safeParse(redirectUri).success) throw new TraktError(CLIENT_ERROR);
  const createdAt = options.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TraktError(AUTH_ERROR);
  const cryptoProvider = options.crypto ?? globalThis.crypto;
  let state: string;
  let verifier: string;
  try {
    state = base64url(cryptoProvider.getRandomValues(new Uint8Array(32)));
    verifier = base64url(cryptoProvider.getRandomValues(new Uint8Array(32)));
  } catch { throw new TraktError("浏览器无法创建安全授权，请使用支持 HTTPS 的现代浏览器。"); }
  const challenge = await traktPkceChallenge(verifier, cryptoProvider);
  const context = { state, verifier, clientId, redirectUri, createdAt };
  const url = new URL("/oauth/authorize", AUTHORITY);
  url.search = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri, state,
    code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  return { context, authorizeUrl: url.href };
}

export function saveTraktAuthorizationContext(storage: TraktTemporaryStorage, context: TraktAuthorizationContext): void {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) throw new TraktError(AUTH_ERROR);
  try { storage.setItem(TRAKT_AUTH_CONTEXT_KEY, JSON.stringify(parsed.data)); }
  catch { throw new TraktError("浏览器无法保存临时授权信息，请允许本站使用会话存储。"); }
}

export function clearTraktAuthorizationContext(storage: TraktTemporaryStorage): void {
  try { storage.removeItem(TRAKT_AUTH_CONTEXT_KEY); }
  catch { throw new TraktError(AUTH_ERROR); }
}

/** Consume before validation: rejected, expired and reused callbacks never reach the token endpoint. */
export function consumeTraktCallback(
  callbackUrl: string,
  storage: TraktTemporaryStorage,
  options: { now?: number } = {},
): { code: string; context: TraktAuthorizationContext } {
  let raw: string | null;
  try {
    raw = storage.getItem(TRAKT_AUTH_CONTEXT_KEY);
    storage.removeItem(TRAKT_AUTH_CONTEXT_KEY);
  } catch { throw new TraktError(AUTH_ERROR); }
  try {
    if (!raw || raw.length > 8_000) throw new Error();
    const result = contextSchema.safeParse(JSON.parse(raw));
    if (!result.success) throw new Error();
    const context = result.data;
    const now = options.now ?? Date.now();
    if (!Number.isSafeInteger(now) || context.createdAt > now || now - context.createdAt > TRAKT_LOCAL_AUTH_MAX_AGE_MS) throw new Error();
    const url = new URL(callbackUrl);
    const redirect = new URL(context.redirectUri);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password || url.hash) throw new Error();
    if (url.searchParams.has("error")) throw new TraktError("Trakt 授权未完成，请重新连接。");
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    if (states.length !== 1 || !states[0] || states[0] !== context.state || codes.length !== 1 || !tokenSchema.safeParse(codes[0]).success) throw new Error();
    return { code: codes[0], context };
  } catch (error) {
    if (error instanceof TraktError) throw error;
    throw new TraktError(AUTH_ERROR);
  }
}

function aborted(): TraktError { return new TraktError("已取消 Trakt 导入。"); }

async function requestJson(url: string, init: RequestInit, options: TraktRequestOptions): Promise<{ value: unknown; headers: Headers }> {
  if (options.signal?.aborted) throw aborted();
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TraktError("Trakt 请求设置不正确，请重新连接。");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    const response = await fetcher(url, {
      ...init, signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) throw new TraktError("Trakt 授权已失效，请重新连接。");
      if (response.status === 403) throw new TraktError("Trakt 拒绝了请求，请检查应用配置后重试。");
      if (response.status === 429) throw new TraktError("Trakt 请求过于频繁，请稍后重试。");
      throw new TraktError("Trakt 服务暂时无法完成请求，请稍后重试。");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_MEDIA_IMPORT_BYTES) throw new TraktError("Trakt 单页数据过大，本次未导入。");
    if (controller.signal.aborted) throw aborted();
    try { return { value: JSON.parse(text), headers: response.headers }; }
    catch { throw new TraktError(DATA_ERROR); }
  } catch (error) {
    if (options.signal?.aborted) throw aborted();
    if (timedOut) throw new TraktError("Trakt 请求超时，请稍后重试。");
    if (error instanceof TraktError) throw error;
    throw new TraktError("无法连接 Trakt，请检查网络和应用的 Allowed origins。");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Return only the access token. The refresh token is intentionally discarded for this one-time import. */
export async function exchangeTraktCode(
  code: string, context: TraktAuthorizationContext, options: TraktRequestOptions = {},
): Promise<string> {
  if (!tokenSchema.safeParse(code).success || !contextSchema.safeParse(context).success) throw new TraktError(AUTH_ERROR);
  const { value } = await requestJson(`${AUTHORITY}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: context.clientId, redirect_uri: context.redirectUri, grant_type: "authorization_code",
      code, code_verifier: context.verifier,
    }),
  }, options);
  const result = z.object({ access_token: tokenSchema, token_type: z.string().refine(type => type.toLowerCase() === "bearer") }).safeParse(value);
  if (!result.success) throw new TraktError("Trakt 未返回有效授权，请重新连接。");
  return result.data.access_token;
}

export async function completeTraktAuthorization(
  callbackUrl: string, storage: TraktTemporaryStorage, options: TraktRequestOptions = {},
): Promise<{ accessToken: string; clientId: string }> {
  const { code, context } = consumeTraktCallback(callbackUrl, storage, options);
  return { accessToken: await exchangeTraktCode(code, context, options), clientId: context.clientId };
}

const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true }).refine(value => !value.startsWith("0000-"));
const titleSchema = z.string().trim().min(1).max(500);
const genresSchema = z.array(z.string().trim().min(1).max(100)).max(30);
const idsSchema = z.object({ trakt: safeId, slug: z.string().max(200).regex(/^[a-z0-9-]+$/i).nullish() });
const titleMetadata = z.object({
  title: titleSchema, year: z.number().int().min(1880).max(2200).nullish(),
  ids: idsSchema, genres: genresSchema.optional(),
});
const episodeMetadata = z.object({
  title: titleSchema.nullish(), ids: idsSchema, genres: genresSchema.optional(),
  season: z.number().int().min(0).max(1_000), number: z.number().int().min(1).max(10_000),
});
const movieHistory = z.object({ id: safeId, watched_at: timestamp, type: z.literal("movie"), movie: titleMetadata });
const episodeHistory = z.object({ id: safeId, watched_at: timestamp, type: z.literal("episode"), episode: episodeMetadata, show: titleMetadata });
const movieRating = z.object({ rated_at: timestamp, rating: z.number().int().min(0).max(10), type: z.literal("movie"), movie: titleMetadata });
const showRating = z.object({ rated_at: timestamp, rating: z.number().int().min(0).max(10), type: z.literal("show"), show: titleMetadata });
const movieWatchlist = z.object({ id: safeId.optional(), listed_at: timestamp, type: z.literal("movie"), movie: titleMetadata });
const showWatchlist = z.object({ id: safeId.optional(), listed_at: timestamp, type: z.literal("show"), show: titleMetadata });
type TitleMetadata = z.infer<typeof titleMetadata>;

function headerInteger(headers: Headers, name: string, minimum: number, maximum: number): number {
  const value = headers.get(name);
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) throw new TraktError(DATA_ERROR);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TraktError(DATA_ERROR);
  return number;
}

async function fetchPages<T>(
  path: string, schema: z.ZodType<T>, key: (row: T) => string | string[], rowLimit: number,
  accessToken: string, clientId: string, options: TraktRequestOptions,
): Promise<T[]> {
  const rows: T[] = [];
  const keys = new Set<string>();
  let expected: { count: number; pages: number; limit: number } | undefined;
  for (let page = 1; ; page += 1) {
    const url = new URL(path, API_ORIGIN);
    url.search = new URLSearchParams({ extended: "full", page: String(page), limit: String(PAGE_SIZE) }).toString();
    const { value, headers } = await requestJson(url.href, {
      method: "GET", headers: { "Content-Type": "application/json", "trakt-api-key": clientId, "trakt-api-version": "2", Authorization: `Bearer ${accessToken}` },
    }, options);
    const result = z.array(schema).max(PAGE_SIZE).safeParse(value);
    if (!result.success) throw new TraktError(DATA_ERROR);
    const current = headerInteger(headers, "X-Pagination-Page", 1, rowLimit);
    const limit = headerInteger(headers, "X-Pagination-Limit", 1, PAGE_SIZE);
    const count = headerInteger(headers, "X-Pagination-Item-Count", 0, rowLimit);
    const pages = headerInteger(headers, "X-Pagination-Page-Count", 0, rowLimit);
    if (current !== page || (count === 0 ? pages > 1 || page !== 1 : pages !== Math.ceil(count / limit))) throw new TraktError(DATA_ERROR);
    if (expected && (expected.count !== count || expected.pages !== pages || expected.limit !== limit)) throw new TraktError(DATA_ERROR);
    expected = { count, pages, limit };
    const expectedLength = count === 0 ? 0 : Math.min(limit, count - (page - 1) * limit);
    if (expectedLength < 0 || result.data.length !== expectedLength) throw new TraktError(DATA_ERROR);
    for (const row of result.data) {
      const identifiers = key(row);
      for (const id of typeof identifiers === "string" ? [identifiers] : identifiers) {
        if (keys.has(id)) throw new TraktError(DATA_ERROR);
        keys.add(id);
      }
      rows.push(row);
    }
    if (page >= pages) {
      if (rows.length !== count) throw new TraktError(DATA_ERROR);
      return rows;
    }
  }
}

/** Import only real viewing events and user ratings; embedded global ratings and CDN image URLs are omitted. */
export async function fetchTraktLibrary(
  accessToken: string, clientId: string, options: TraktRequestOptions = {},
): Promise<MediaLibrary> {
  if (!tokenSchema.safeParse(accessToken).success || !clientIdSchema.safeParse(clientId).success) throw new TraktError("Trakt 授权信息不完整，请重新连接。");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new TraktError(DATA_ERROR);
  const entries = new Map<string, MediaEntry>();
  const historyIds = new Set<number>();
  function title(kind: "movie" | "show", metadata: TitleMetadata): MediaEntry {
    const id = traktMediaId(kind, metadata.ids.trakt);
    const previous = entries.get(id);
    const record: MediaEntry = {
      id, kind, title: metadata.title, ...(metadata.year == null ? {} : { year: metadata.year }),
      genres: metadata.genres ?? previous?.genres ?? [], status: previous?.status ?? "unclassified",
      history: previous?.history ?? [], traktId: metadata.ids.trakt,
      ...(metadata.ids.slug ? { traktUrl: `https://trakt.tv/${kind === "movie" ? "movies" : "shows"}/${metadata.ids.slug}` } : {}),
      ...(previous?.rating === undefined ? {} : { rating: previous.rating }),
    };
    entries.set(id, record);
    if (entries.size > 10_000) throw new TraktError("Trakt 作品超过本地保存上限，本次未导入。");
    return record;
  }
  function history(entry: MediaEntry, id: number, watchedAt: string): void {
    if (historyIds.has(id)) throw new TraktError(DATA_ERROR);
    historyIds.add(id);
    if (historyIds.size > 50_000 || entry.history.length >= 5_000) throw new TraktError("Trakt 观看记录超过本地保存上限，本次未导入。");
    entry.history.push({ id: `trakt:history:${id}`, watchedAt });
    entry.status = "watched";
  }
  const movies = await fetchPages("/users/me/history/movies", movieHistory, row => String(row.id), 50_000, accessToken, clientId, options);
  for (const row of movies) history(title("movie", row.movie), row.id, row.watched_at);
  const episodes = await fetchPages("/users/me/history/episodes", episodeHistory, row => String(row.id), 50_000, accessToken, clientId, options);
  for (const row of episodes) {
    const show = title("show", row.show);
    const id = traktMediaId("episode", row.episode.ids.trakt);
    const previous = entries.get(id);
    if (previous && (previous.showId !== show.id || previous.season !== row.episode.season || previous.episode !== row.episode.number)) throw new TraktError(DATA_ERROR);
    const entry: MediaEntry = {
      id, kind: "episode", title: row.episode.title ?? `${show.title} · S${row.episode.season}E${row.episode.number}`,
      genres: row.episode.genres ?? previous?.genres ?? [], status: "watched", history: previous?.history ?? [],
      traktId: row.episode.ids.trakt, showId: show.id, season: row.episode.season, episode: row.episode.number,
      ...(row.show.ids.slug ? { traktUrl: `https://trakt.tv/shows/${row.show.ids.slug}/seasons/${row.episode.season}/episodes/${row.episode.number}` } : {}),
    };
    entries.set(id, entry);
    if (entries.size > 10_000) throw new TraktError("Trakt 作品超过本地保存上限，本次未导入。");
    history(entry, row.id, row.watched_at);
  }
  const movieRatings = await fetchPages("/users/me/ratings/movies", movieRating, row => String(row.movie.ids.trakt), 10_000, accessToken, clientId, options);
  for (const row of movieRatings) title("movie", row.movie).rating = row.rating;
  const showRatings = await fetchPages("/users/me/ratings/shows", showRating, row => String(row.show.ids.trakt), 10_000, accessToken, clientId, options);
  for (const row of showRatings) title("show", row.show).rating = row.rating;
  const wantedMovies = await fetchPages("/users/me/watchlist/movies", movieWatchlist, row => [
    `movie:${row.movie.ids.trakt}`, ...(row.id === undefined ? [] : [`item:${row.id}`]),
  ], 10_000, accessToken, clientId, options);
  for (const row of wantedMovies) {
    const entry = title("movie", row.movie);
    if (entry.status === "unclassified") entry.status = "wanted";
  }
  const wantedShows = await fetchPages("/users/me/watchlist/shows", showWatchlist, row => [
    `show:${row.show.ids.trakt}`, ...(row.id === undefined ? [] : [`item:${row.id}`]),
  ], 10_000, accessToken, clientId, options);
  for (const row of wantedShows) {
    const entry = title("show", row.show);
    if (entry.status === "unclassified") entry.status = "wanted";
  }
  if (options.signal?.aborted) throw aborted();
  const result = mediaLibrarySchema.safeParse({ version: 1, source: "trakt", syncedAt: new Date(now).toISOString(), entries: [...entries.values()] });
  if (!result.success) throw new TraktError(DATA_ERROR);
  if (new TextEncoder().encode(JSON.stringify(result.data)).byteLength > MAX_MEDIA_IMPORT_BYTES) throw new TraktError("Trakt 资料超过导入文件大小上限，本次未导入。");
  return result.data;
}
