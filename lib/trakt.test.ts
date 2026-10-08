import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRAKT_AUTH_CONTEXT_KEY, TRAKT_LOCAL_AUTH_MAX_AGE_MS, TraktError,
  clearTraktAuthorizationContext, completeTraktAuthorization, consumeTraktCallback,
  createTraktAuthorization, exchangeTraktCode, fetchTraktLibrary, saveTraktAuthorizationContext, traktPkceChallenge,
  type TraktAuthorizationContext, type TraktTemporaryStorage,
} from "./trakt";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const REDIRECT = "https://example.github.io/workbench/trakt/callback/";
const TOKEN = "private-access-token";
const CLIENT = "client-id-123";
const context = (changes: Partial<TraktAuthorizationContext> = {}): TraktAuthorizationContext => ({
  state: "s".repeat(43), verifier: "v".repeat(43), clientId: CLIENT, redirectUri: REDIRECT, createdAt: NOW, ...changes,
});
function storage(): TraktTemporaryStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
const callback = (state = context().state) => `${REDIRECT}?code=private-authorization-code&state=${state}`;
function pageResponse(items: unknown[], page = 1, limit = 250, count = items.length, overrides: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(items), { headers: {
    "Content-Type": "application/json", "X-Pagination-Page": String(page), "X-Pagination-Limit": String(limit),
    "X-Pagination-Item-Count": String(count), "X-Pagination-Page-Count": String(Math.ceil(count / limit)), ...overrides,
  } });
}
const movie = (id: number, changes: Record<string, unknown> = {}) => ({
  title: `Original movie ${id}`, year: 2025, ids: { trakt: id, slug: `movie-${id}` }, genres: ["science-fiction"],
  rating: 9.9, images: { poster: ["walter-r2.trakt.tv/private-cdn-image.webp"] }, ...changes,
});
const show = (id: number, changes: Record<string, unknown> = {}) => ({
  title: `Original show ${id}`, ids: { trakt: id, slug: `show-${id}` }, genres: ["drama"], ...changes,
});
const watchedAt = "2026-10-07T10:00:00Z";
const historyMovie = (id = 101, titleId = 1) => ({ id, type: "movie", watched_at: watchedAt, movie: movie(titleId) });
const historyEpisode = (id = 103) => ({
  id, type: "episode", watched_at: watchedAt,
  episode: { title: "Original episode", ids: { trakt: 9 }, season: 1, number: 2 }, show: show(4),
});
const ratingMovie = (id = 1, rating = 8) => ({ type: "movie", rated_at: watchedAt, rating, movie: movie(id) });
const ratingShow = (id = 4, rating = 7) => ({ type: "show", rated_at: watchedAt, rating, show: show(id) });
const wantedMovie = (id = 3) => ({ id: 400 + id, type: "movie", listed_at: watchedAt, movie: movie(id) });
const wantedShow = (id = 5) => ({ id: 500 + id, type: "show", listed_at: watchedAt, show: show(id) });
function libraryFetch(datasets: Record<string, unknown[]> = {}, limit = 250) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.trakt.tv");
    expect(url.searchParams.get("extended")).toBe("full");
    expect(url.searchParams.get("limit")).toBe("250");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("trakt-api-key")).toBe(CLIENT);
    expect(headers.get("trakt-api-version")).toBe("2");
    const rows = datasets[url.pathname] ?? [];
    const page = Number(url.searchParams.get("page"));
    return pageResponse(rows.slice((page - 1) * limit, page * limit), page, limit, rows.length);
  });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Trakt browser PKCE", () => {
  it("matches the RFC 7636 S256 challenge", async () => {
    expect(await traktPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates independent secure contexts and a secret-free authorization URL", async () => {
    const first = await createTraktAuthorization(CLIENT, REDIRECT, { now: NOW });
    const second = await createTraktAuthorization(CLIENT, REDIRECT, { now: NOW });
    const url = new URL(first.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://auth.trakt.tv/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await traktPkceChallenge(first.context.verifier));
    expect(first.context.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.context.state).not.toBe(second.context.state);
    expect(first.context.verifier).not.toBe(second.context.verifier);
    expect(first.authorizeUrl).not.toContain(first.context.verifier);
    expect(first.authorizeUrl).not.toContain("client_secret");
    const temporary = storage();
    saveTraktAuthorizationContext(temporary, first.context);
    expect(Object.keys(JSON.parse(temporary.getItem(TRAKT_AUTH_CONTEXT_KEY)!)).sort()).toEqual(["clientId", "createdAt", "redirectUri", "state", "verifier"]);
    clearTraktAuthorizationContext(temporary);
    expect(temporary.values.size).toBe(0);
  });

  it.each(["http://example.com/callback", "https://user:secret@example.com/callback", "https://example.com/callback?secret=value", "https://example.com/callback#value"])("rejects unsafe redirect %s without echoing it", async redirect => {
    await expect(createTraktAuthorization(CLIENT, redirect)).rejects.toThrow("请填写有效的 Trakt Client ID");
  });

  it("exchanges a consumed callback only once and discards the refresh token", async () => {
    const temporary = storage();
    saveTraktAuthorizationContext(temporary, context());
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ access_token: TOKEN, token_type: "Bearer", refresh_token: "private-refresh-token" })));
    const result = await completeTraktAuthorization(callback(), temporary, { fetch: fetcher, now: NOW });
    expect(result).toEqual({ accessToken: TOKEN, clientId: CLIENT });
    expect(temporary.values.size).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://auth.trakt.tv/oauth/token");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: CLIENT, redirect_uri: REDIRECT, grant_type: "authorization_code", code: "private-authorization-code", code_verifier: context().verifier });
    await expect(completeTraktAuthorization(callback(), temporary, { fetch: fetcher, now: NOW })).rejects.toThrow(TraktError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty state", `${REDIRECT}?code=private-code&state=`, context()],
    ["missing state", `${REDIRECT}?code=private-code`, context()],
    ["wrong state", callback("private-wrong-state"), context()],
    ["duplicate state", `${callback()}&state=${context().state}`, context()],
    ["missing code", `${REDIRECT}?state=${context().state}`, context()],
    ["duplicate code", `${callback()}&code=private-second-code`, context()],
    ["wrong origin", callback().replace("example.github.io", "attacker.github.io"), context()],
    ["wrong path", callback().replace("/callback/", "/other/"), context()],
    ["future context", callback(), context({ createdAt: NOW + 1 })],
    ["expired context", callback(), context({ createdAt: NOW - TRAKT_LOCAL_AUTH_MAX_AGE_MS - 1 })],
    ["invalid client", callback(), context({ clientId: "private invalid client" })],
    ["invalid verifier", callback(), context({ verifier: "private-invalid" })],
  ])("rejects %s before any API request and consumes its context", async (_label, url, pending) => {
    const temporary = storage();
    temporary.setItem(TRAKT_AUTH_CONTEXT_KEY, JSON.stringify(pending));
    const fetcher = vi.fn<typeof fetch>();
    const error = await completeTraktAuthorization(url, temporary, { fetch: fetcher, now: NOW }).catch(value => value);
    expect(error).toBeInstanceOf(TraktError);
    expect(error.message).toBe("临时授权信息无效或已过期，请重新连接 Trakt。");
    expect(error.message).not.toContain("private");
    expect(fetcher).not.toHaveBeenCalled();
    expect(temporary.values.size).toBe(0);
  });

  it("rejects missing or corrupt stored contexts and handles denial without exposing descriptions", async () => {
    for (const raw of [null, "private-invalid-json", JSON.stringify({ ...context(), access_token: TOKEN })]) {
      const temporary = storage();
      if (raw !== null) temporary.setItem(TRAKT_AUTH_CONTEXT_KEY, raw);
      expect(() => consumeTraktCallback(callback(), temporary, { now: NOW })).toThrow(TraktError);
      expect(temporary.values.size).toBe(0);
    }
    const temporary = storage();
    saveTraktAuthorizationContext(temporary, context());
    const fetcher = vi.fn<typeof fetch>();
    await expect(completeTraktAuthorization(`${REDIRECT}?error=access_denied&error_description=${TOKEN}&state=${context().state}`, temporary, { fetch: fetcher, now: NOW })).rejects.toThrow("Trakt 授权未完成，请重新连接。");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ access_token: TOKEN, token_type: "basic" }, { access_token: "", token_type: "bearer" }, { refresh_token: TOKEN }, { access_token: "Bearer private token", token_type: "bearer" }])("rejects incomplete token responses without reflecting data", async reply => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(reply)));
    await expect(exchangeTraktCode("private-code", context(), { fetch: fetcher })).rejects.toThrow("Trakt 未返回有效授权，请重新连接。");
  });
});

describe("Trakt complete read-only library imports", () => {
  it("retains safe movie posters across metadata updates and gives episodes their show's poster", async () => {
    const path = "walter-r2.trakt.tv/images/movies/000/012/601/posters/thumb/e0d9dd35c5.jpg.webp";
    const poster = `https://${path}`;
    const episode = historyEpisode();
    const fetcher = libraryFetch({
      "/users/me/history/movies": [{ ...historyMovie(), movie: movie(1, { images: { poster: ["https://evil.test/x.webp", path] } }) }],
      "/users/me/history/episodes": [{ ...episode, show: show(4, { images: { poster: [path] } }) }],
      "/users/me/ratings/movies": [ratingMovie()],
    });
    const result = await fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW });
    expect(result.entries.find(entry => entry.id === "trakt:movie:1")?.poster).toBe(poster);
    expect(result.entries.find(entry => entry.id === "trakt:show:4")?.poster).toBe(poster);
    expect(result.entries.find(entry => entry.id === "trakt:episode:9")?.poster).toBe(poster);
    expect(JSON.stringify(result)).not.toContain("evil.test");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const lateArtwork = await fetchTraktLibrary(TOKEN, CLIENT, { fetch: libraryFetch({
      "/users/me/history/episodes": [historyEpisode()],
      "/users/me/ratings/shows": [{ ...ratingShow(), show: show(4, { images: { poster: [path] } }) }],
    }), now: NOW });
    expect(lateArtwork.entries.find(entry => entry.id === "trakt:episode:9")?.poster).toBe(poster);
  });
  it.each(["injected", "global"])("binds %s fetch to the browser global receiver", async mode => {
    const fetcher = vi.fn<typeof fetch>(async function (this: typeof globalThis) {
      expect(this).toBe(globalThis);
      return pageResponse([]);
    });
    if (mode === "global") vi.stubGlobal("fetch", fetcher);
    await fetchTraktLibrary(TOKEN, CLIENT, { ...(mode === "injected" ? { fetch: fetcher } : {}), now: NOW });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("paginates real rewatches and episodes, preserves user scores, and never infers a completed show", async () => {
    const fetcher = libraryFetch({
      "/users/me/history/movies": [historyMovie(), { ...historyMovie(102), watched_at: "2026-10-08T09:00:00Z" }],
      "/users/me/history/episodes": [historyEpisode()],
      "/users/me/ratings/movies": [ratingMovie(), ratingMovie(8, 0)],
      "/users/me/ratings/shows": [ratingShow()],
      "/users/me/watchlist/movies": [wantedMovie(1), wantedMovie()],
      "/users/me/watchlist/shows": [wantedShow()],
    }, 1);
    const result = await fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW });
    expect(result.source).toBe("trakt");
    expect(result.syncedAt).toBe(new Date(NOW).toISOString());
    expect(result.entries).toHaveLength(6);
    const entries = new Map(result.entries.map(entry => [entry.id, entry]));
    expect(entries.get("trakt:movie:1")).toMatchObject({ title: "Original movie 1", status: "watched", rating: 8, genres: ["science-fiction"], history: [
      { id: "trakt:history:101", watchedAt }, { id: "trakt:history:102", watchedAt: "2026-10-08T09:00:00Z" },
    ] });
    expect(entries.get("trakt:show:4")).toMatchObject({ status: "unclassified", rating: 7, genres: ["drama"], history: [] });
    expect(entries.get("trakt:episode:9")).toMatchObject({ status: "watched", showId: "trakt:show:4", season: 1, episode: 2, genres: [], history: [{ id: "trakt:history:103", watchedAt }] });
    expect(entries.get("trakt:movie:8")).toMatchObject({ status: "unclassified", rating: 0, history: [] });
    expect(entries.get("trakt:movie:3")).toMatchObject({ status: "wanted", history: [] });
    expect(entries.get("trakt:show:5")).toMatchObject({ status: "wanted", history: [] });
    expect(JSON.stringify(result)).not.toContain("private-cdn");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("9.9");
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/users/me/history/movies", "/users/me/history/movies", "/users/me/history/episodes",
      "/users/me/ratings/movies", "/users/me/ratings/movies", "/users/me/ratings/shows",
      "/users/me/watchlist/movies", "/users/me/watchlist/movies", "/users/me/watchlist/shows",
    ]);
  });

  it("marks a parent show wanted only when the watchlist explicitly includes it", async () => {
    const fetcher = libraryFetch({ "/users/me/history/episodes": [historyEpisode()], "/users/me/watchlist/shows": [wantedShow(4)] });
    const result = await fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW });
    expect(result.entries.find(entry => entry.id === "trakt:show:4")).toMatchObject({ status: "wanted", history: [] });
    expect(result.entries.find(entry => entry.id === "trakt:episode:9")).toMatchObject({ status: "watched", history: [{ id: "trakt:history:103", watchedAt }] });
  });

  it("accepts truly empty endpoints and never requests watched-summary APIs", async () => {
    const fetcher = libraryFetch();
    expect(await fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW })).toEqual({ version: 1, source: "trakt", syncedAt: new Date(NOW).toISOString(), entries: [] });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/watched"))).toBe(false);
  });

  it.each([
    ["missing pagination", new Response(JSON.stringify([historyMovie()]))],
    ["incorrect cursor", pageResponse([historyMovie()], 2)],
    ["zero effective limit", pageResponse([historyMovie()], 1, 250, 1, { "X-Pagination-Limit": "0" })],
    ["inconsistent page count", pageResponse([historyMovie()], 1, 250, 1, { "X-Pagination-Page-Count": "2" })],
    ["clamped-but-truncated page", pageResponse([], 1, 1, 1)],
    ["oversized import count", pageResponse([historyMovie()], 1, 250, 50_001)],
    ["unsafe numeric history id", pageResponse([historyMovie(Number.MAX_SAFE_INTEGER + 1)])],
    ["missing parent show", pageResponse([{ ...historyMovie(), movie: { title: "private-title", ids: {} } }])],
    ["wrong response shape", new Response(JSON.stringify({ privateToken: TOKEN }))],
  ])("rejects %s as a whole import", async (_label, response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW })).rejects.toThrow("Trakt 返回的数据不完整");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects repeated page ids and changing pagination totals", async () => {
    for (const second of [pageResponse([historyMovie()], 2, 1, 2), pageResponse([historyMovie(102)], 2, 1, 3)]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(pageResponse([historyMovie()], 1, 1, 2)).mockResolvedValueOnce(second);
      await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW })).rejects.toThrow("Trakt 返回的数据不完整");
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects duplicate history identities across movies and episodes", async () => {
    const fetcher = libraryFetch({ "/users/me/history/movies": [historyMovie()], "/users/me/history/episodes": [historyEpisode(101)] });
    await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW })).rejects.toThrow("Trakt 返回的数据不完整");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate watchlist item IDs even when their media IDs differ", async () => {
    const fetcher = libraryFetch({ "/users/me/watchlist/movies": [wantedMovie(3), { ...wantedMovie(6), id: 403 }] }, 1);
    await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW })).rejects.toThrow("Trakt 返回的数据不完整");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("rejects a later malformed endpoint instead of returning partial history", async () => {
    const fetcher = libraryFetch({ "/users/me/history/movies": [historyMovie()], "/users/me/ratings/shows": [ratingShow(4, 11)] });
    await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW })).rejects.toThrow("Trakt 返回的数据不完整");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403, 429, 500])("handles HTTP %i without retries or credential reflection", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: TOKEN, error_description: "private-server-body" }), { status }));
    const error = await fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, now: NOW }).catch(value => value);
    expect(error).toBeInstanceOf(TraktError);
    expect(error.message).not.toContain("private");
    expect(fetcher).toHaveBeenCalledOnce();
    if (status === 429) expect(error.message).toBe("Trakt 请求过于频繁，请稍后重试。");
  });

  it("redacts network errors and invalid credential inputs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`private-network-details ${TOKEN}`));
    await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher })).rejects.toThrow("无法连接 Trakt");
    fetcher.mockClear();
    await expect(fetchTraktLibrary("private token with spaces", CLIENT, { fetch: fetcher })).rejects.toThrow("Trakt 授权信息不完整");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports cancelling before or during a request", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const unused = vi.fn<typeof fetch>();
    await expect(fetchTraktLibrary(TOKEN, CLIENT, { fetch: unused, signal: cancelled.signal })).rejects.toThrow("已取消 Trakt 导入。");
    expect(unused).not.toHaveBeenCalled();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(TOKEN)), { once: true });
    }));
    const promise = fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow("已取消 Trakt 导入。");
  });

  it("bounds request time and keeps timeout errors free of response details", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(TOKEN)), { once: true });
    }));
    const promise = fetchTraktLibrary(TOKEN, CLIENT, { fetch: fetcher, timeoutMs: 100 });
    const assertion = expect(promise).rejects.toThrow("Trakt 请求超时，请稍后重试。");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
