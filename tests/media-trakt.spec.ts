import { test as base, readPreviewWorkspace, writePreviewWorkspace, decodePreviewWorkspace } from "./preview-fixtures";
import { optionalSnapshot } from "./snapshot-audit";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { emptyLifeData, lifeDataSchema, type LifeData } from "../lib/life";
import { TRAKT_AUTH_CONTEXT_KEY } from "../lib/trakt";

const STORAGE_KEY = "life-workbench-preview-v1";
const APP_URL = "https://templehao.github.io/codex/";
const APP_ORIGIN = new URL(APP_URL).origin;
const LOCAL_ORIGIN = "http://127.0.0.1:3200";
const CLIENT_ID = "test-only-public-trakt-client-id";
const AUTHORIZATION_CODE = "test-only-authorization-code";
const ACCESS_TOKEN = "test-only-access-token";
const REFRESH_TOKEN = "test-only-refresh-token";
const FAILED_POSTER_URL = "https://media.trakt.tv/images/movies/000/012/602/posters/thumb/failed.jpg.webp";
const NATIVE_POSTER_URL = "https://media.trakt.tv/images/movies/000/012/601/posters/thumb/e0d9dd35c5.jpg.webp";
const PUBLIC_POSTER_URL = NATIVE_POSTER_URL;
const MOCK_WEBP = Buffer.from("UklGRi4AAABXRUJQVlA4ICIAAABQAQCdASoCAAMAAUAmJQBOgC6gAP7wxASMNGvr1093/cAA", "base64");
const SUMMARY_IMDB_IDS: Record<string, string> = {
  "/movies/1": "tt1375666", "/movies/3": "tt0816692", "/movies/8": "tt0133093",
  "/shows/4": "tt0903747", "/shows/5": "tt5753856",
};
const PUBLIC_SUMMARIES = new Set(Object.keys(SUMMARY_IMDB_IDS));
const METAHUB_POSTER_URLS = new Set(Object.values(SUMMARY_IMDB_IDS).map(id => `https://images.metahub.space/poster/medium/${id}/img`));
const isMockPosterUrl = (url: URL) => ["https://walter-r2.trakt.tv", "https://media.trakt.tv"].includes(url.origin) || METAHUB_POSTER_URLS.has(url.href);
const ENDPOINTS = [
  "/users/me/history/movies", "/users/me/history/episodes", "/users/me/ratings/movies",
  "/users/me/ratings/shows", "/users/me/watchlist/movies", "/users/me/watchlist/shows",
] as const;
type StoredWorkspace = { version: 1; tasks: unknown[]; sources: unknown[]; batches: Record<string, unknown>; life: LifeData };

const test = base.extend<{ audit: void }>({
  audit: [async ({ page }, use, testInfo) => {
    // Only this test's intentionally rejected image may fail through the worker.
    const intentionalPosterFallback = (value: string) => {
      if (!testInfo.title.startsWith("海报从官方来源缓存为Blob")) return false;
      try {
        const url = new URL(value);
        return [APP_ORIGIN, LOCAL_ORIGIN].includes(url.origin)
          && ["/codex/media-poster-cache", "/media-poster-cache"].includes(url.pathname)
          && url.searchParams.get("url") === FAILED_POSTER_URL;
      } catch { return false; }
    };
    const forbiddenRequests: string[] = [];
    const pageErrors: string[] = [];
    const assetFailures: string[] = [];
    const rejectedPosters = new Set<string>();
    page.on("request", request => {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      const app = [APP_ORIGIN, LOCAL_ORIGIN].includes(url.origin);
      const auth = url.origin === "https://auth.trakt.tv" && ["/oauth/authorize", "/oauth/token"].includes(url.pathname);
      const poster = isMockPosterUrl(url) && request.resourceType() === "fetch";
      const api = url.origin === "https://api.trakt.tv" && (ENDPOINTS.some(path => path === url.pathname) || PUBLIC_SUMMARIES.has(url.pathname));
      if ((!app && !auth && !api && !poster) || (app && /(?:^|\/)api(?:\/|$)/.test(url.pathname))) forbiddenRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      if (optionalSnapshot(message.location().url) && /Failed to load resource/.test(message.text())) return;
      // The failure case deliberately returns HTTP 500 from a mocked data endpoint.
      if (["https://api.trakt.tv/", "https://walter-r2.trakt.tv/", "https://media.trakt.tv/"].some(origin => message.location().url.startsWith(origin)) && /Failed to load resource/.test(message.text())) return;
      if (intentionalPosterFallback(message.location().url) && /Failed to load resource.*(?:net::ERR_FAILED|status of 500)/.test(message.text())) return;
      pageErrors.push(message.text());
    });
    page.on("response", response => {
      if (METAHUB_POSTER_URLS.has(response.url()) && response.status() >= 400) assetFailures.push(`${response.status()} ${response.url()}`);
      if (["https://walter-r2.trakt.tv", "https://media.trakt.tv"].includes(new URL(response.url()).origin) && response.status() >= 400) rejectedPosters.add(response.url());
      if ([APP_ORIGIN, LOCAL_ORIGIN].includes(new URL(response.url()).origin) && response.status() >= 400 && !(response.status() === 404 && optionalSnapshot(response.url())) && !intentionalPosterFallback(response.url())) assetFailures.push(`${response.status()} ${response.url()}`);
    });
    page.on("requestfailed", request => {
      if (optionalSnapshot(request.url()) && request.failure()?.errorText === "net::ERR_ABORTED") return;
      // The downloader cancels an HTTP-error body; the poster test deliberately
      // returns one such response and verifies the fallback plus successful retry.
      if (rejectedPosters.has(request.url()) && request.failure()?.errorText === "net::ERR_ABORTED") return;
      if (intentionalPosterFallback(request.url()) && request.resourceType() === "image" && request.failure()?.errorText === "net::ERR_FAILED") return;
      assetFailures.push(`${request.failure()?.errorText} ${request.url()}`);
    });
    await use();
    expect(forbiddenRequests, "影音页面只加载本站资源并使用指定的模拟 Trakt 接口").toEqual([]);
    expect(pageErrors, "保存和授权不应产生未处理的页面错误").toEqual([]);
    expect(assetFailures, "静态资源与授权导航应成功完成").toEqual([]);
  }, { auto: true }],
});

function originalState(): StoredWorkspace {
  const life = emptyLifeData();
  const timestamp = "2025-09-01T12:00:00.000Z";
  life.reading.books = [{ id: "kept-book", title: "以前保存的书", author: "旧作者", kind: "ebook", status: "reading", progress: 25 }];
  life.reading.highlights = [{ id: "kept-highlight", bookId: "kept-book", text: "阅读自己的生活。" }];
  life.thoughts = [{ id: "11111111-1111-4111-8111-111111111111", title: "独立的思考", body: "不被影音导入覆盖。", createdAt: timestamp, updatedAt: timestamp }];
  life.board = {
    threads: [{ id: "22222222-2222-4222-8222-222222222222", title: "保留生活里独立的兴趣", area: "阅读", kind: "interest", state: "active", description: "允许兴趣没有任务。", createdAt: timestamp, updatedAt: timestamp }],
    observations: [{ id: "33333333-3333-4333-8333-333333333333", area: "生活", kind: "feeling", text: "从前记下的平静。", date: "2025-09-01", createdAt: timestamp }],
    reviews: [],
  };
  life.media.entries = [
    { id: "trakt:movie:1", traktId: 1, kind: "movie", title: "原来的片名", genres: [], status: "watched", rating: 6.5, thought: "我以前写下的观影感想必须保留。", history: [{ id: "manual:kept-view", watchedAt: "2024-05-06" }] },
    { id: "manual:kept-movie", kind: "movie", title: "自己记下的旧电影", genres: [], status: "wanted", thought: "手动作品也继续保留。", history: [] },
  ];
  return { version: 1, tasks: [], sources: [], batches: {}, life: lifeDataSchema.parse(life) };
}

async function rawStorage(page: Page) { return page.evaluate(key => localStorage.getItem(key), STORAGE_KEY); }
async function persisted(page: Page): Promise<StoredWorkspace | null> {
  return readPreviewWorkspace<StoredWorkspace>(page);
}
async function ensureMediaSettingsOpen(page: Page) {
  const settings = page.locator("details.media-settings");
  if (await settings.count() && !await settings.evaluate(node => (node as HTMLDetailsElement).open)) {
    await settings.locator(":scope > summary").click();
  }
}
async function selectView(page: Page, name: string) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
  if (name === "影音") await ensureMediaSettingsOpen(page);
}
async function openMedia(page: Page, options: { https?: boolean; seed?: StoredWorkspace } = {}) {
  if (options.https) {
    await page.route(`${APP_ORIGIN}/codex/**`, async route => {
      const requested = new URL(route.request().url());
      const response = await route.fetch({ url: `${LOCAL_ORIGIN}${requested.pathname}${requested.search}` });
      await route.fulfill({ response });
    });
  }
  await page.goto(options.https ? APP_URL : "./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  if (options.seed) {
    await writePreviewWorkspace(page, options.seed);
    await page.reload();
    await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  }
  await selectView(page, "影音");
  await expect(page.getByRole("heading", { name: "故事，也是人生的线头。", exact: true })).toBeVisible();
}
async function openMediaDetail(page: Page, title: string) {
  const detail = page.getByRole("dialog", { name: "影音详情", exact: true });
  if (!await detail.isVisible()) await page.locator(".media-title").filter({ hasText: title }).first().click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(title);
  return detail;
}
async function closeMediaDetail(page: Page) {
  const detail = page.getByRole("dialog", { name: "影音详情", exact: true });
  if (await detail.isVisible()) await detail.getByRole("button", { name: "关闭影音详情", exact: true }).click();
  await expect(detail).not.toBeVisible();
}
async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
}
async function expectNoTasks(page: Page) {
  const saved = await persisted(page);
  expect(saved?.tasks ?? []).toEqual([]);
  expect(saved?.sources ?? []).toEqual([]);
}

test("打开旧片单自动补齐小约翰官方封面，不依赖IMDb或账号授权且保留人生资料", async ({ page, context }) => {
  const poster = "https://media.trakt.tv/images/shows/000/312/285/posters/thumb/69c487addb.jpg.webp";
  let downloads = 0;
  await context.route(poster, async route => {
    downloads++;
    await route.fulfill({ contentType: "image/webp", body: MOCK_WEBP });
  });
  const seed = originalState();
  seed.life.media.entries = [{ ...seed.life.media.entries[0], id: "trakt:show:312285", traktId: 312285, kind: "show", title: "小约翰可汗-充电系列", year: 2025 }];
  await openMedia(page, { seed });
  await expect.poll(async () => (await persisted(page))?.life.media.entries[0]?.poster).toBe(poster);
  const saved = await persisted(page);
  expect(saved?.life.media.entries[0]).toEqual({ ...seed.life.media.entries[0], poster });
  expect(saved?.life.reading).toEqual(seed.life.reading);
  expect(saved?.life.thoughts).toEqual(seed.life.thoughts);
  expect(saved?.life.board).toEqual(seed.life.board);
  expect(await connectionRecord(page)).toBeNull();
  const image = page.locator(".media-title-art img");
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(2);
  expect(downloads).toBe(1);
  await page.reload();
  await selectView(page, "影音");
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(2);
  expect(downloads).toBe(1);
});

test("缺图作品区分暂无封面，单部诊断只复制公开编号且不改原始资料", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const seed = originalState();
  seed.life.media.entries = [{ ...seed.life.media.entries[0], id: "trakt:show:1", kind: "show", title: "Glad To Know You", year: 2020, traktUrl: "https://trakt.tv/shows/public-show-2020" }];
  await openMedia(page, { seed });
  const before = await rawStorage(page);
  await expect(page.locator(".media-title-art")).toHaveAttribute("data-poster-state", "missing");
  await expect(page.locator(".media-title-art")).toContainText("暂无封面");
  const detail = await openMediaDetail(page, "Glad To Know You");
  await expect(detail).toContainText("从 Trakt 作品详情补查官方封面");
  await detail.getByText("这部作品的封面诊断", { exact: true }).click();
  await detail.getByRole("button", { name: "复制这部作品的封面诊断", exact: true }).click();
  const report = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(report)).toMatchObject({ traktId: 1, imdbId: null, hasPosterAddress: false, state: "missing", traktUrl: "https://trakt.tv/shows/public-show-2020" });
  for (const privateValue of [seed.life.media.entries[0].title, seed.life.media.entries[0].thought!, seed.life.media.entries[0].history[0].watchedAt, ACCESS_TOKEN, REFRESH_TOKEN]) expect(report).not.toContain(privateValue);
  expect(await rawStorage(page)).toBe(before);
});
async function expectAuthorizationCleared(page: Page, secrets: string[]) {
  await expect(page).toHaveURL(APP_URL);
  expect(await page.evaluate(key => sessionStorage.getItem(key), TRAKT_AUTH_CONTEXT_KEY)).toBeNull();
  const browserValues = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const secret of secrets.filter(Boolean)) {
    expect(page.url()).not.toContain(secret);
    expect(browserValues).not.toContain(secret);
  }
  expect(new URL(page.url()).searchParams.has("code")).toBe(false);
  expect(new URL(page.url()).searchParams.has("state")).toBe(false);
}

async function connectionRecord(page: Page) {
  return page.evaluate(async () => new Promise<{ session: { accessToken: string; refreshToken: string; expiresAt: number }; syncedAt: string | null } | null>((resolve, reject) => {
    const request = indexedDB.open("life-workbench-trakt-connection-v1", 1);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("connection")) { db.close(); resolve(null); return; }
      const tx = db.transaction("connection", "readonly");
      const read = tx.objectStore("connection").get("active");
      tx.oncomplete = () => { resolve(read.result ?? null); db.close(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error("connection read failed")); };
    };
    request.onerror = () => reject(new Error("connection database unavailable"));
  }));
}
async function expireConnectionSoon(page: Page) {
  await page.evaluate(async () => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("life-workbench-trakt-connection-v1", 1);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("connection", "readwrite");
      const store = tx.objectStore("connection");
      const read = store.get("active");
      read.onsuccess = () => { const record = read.result; record.session.expiresAt = Date.now() + 30_000; store.put(record, "active"); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error("connection expiry update failed")); };
    };
    request.onerror = () => reject(new Error("connection database unavailable"));
  }));
}

function traktDatasets(): Record<string, unknown[]> {
  const watchedAt = "2025-12-31T18:00:00Z";
  const movie = (id: number) => ({ title: `Original movie ${id}`, year: 2025, ids: { trakt: id, slug: `movie-${id}` }, genres: ["science-fiction"], rating: 9.9, images: { poster: ["private-cdn-image.example"] } });
  const show = (id: number) => ({ title: `Original show ${id}`, year: 2024, ids: { trakt: id, slug: `show-${id}` }, genres: ["drama"] });
  return {
    "/users/me/history/movies": [{ id: 101, type: "movie", watched_at: watchedAt, movie: movie(1) }],
    "/users/me/history/episodes": [{ id: 103, type: "episode", watched_at: "2026-01-01T02:30:00+09:00", episode: { title: "Original episode", ids: { trakt: 9 }, season: 1, number: 2 }, show: show(4) }],
    "/users/me/ratings/movies": [{ type: "movie", rated_at: watchedAt, rating: 8, movie: movie(1) }, { type: "movie", rated_at: watchedAt, rating: 0, movie: movie(8) }],
    "/users/me/ratings/shows": [{ type: "show", rated_at: watchedAt, rating: 7, show: show(4) }],
    "/users/me/watchlist/movies": [{ id: 403, type: "movie", listed_at: watchedAt, movie: movie(3) }],
    "/users/me/watchlist/shows": [{ id: 505, type: "show", listed_at: watchedAt, show: show(5) }],
  };
}

async function mockTrakt(page: Page) {
  const result = { states: [] as string[], verifiers: [] as string[], challenges: [] as string[], tokenCalls: 0, refreshCalls: 0, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, apiCalls: [] as string[], summaryCalls: [] as string[], summaryAuthorizations: [] as (string | undefined)[], summaryGate: null as Promise<void> | null, badState: false, failPath: "", rejectOncePath: "" };
  const cors = {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, trakt-api-key, trakt-api-version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Pagination-Page, X-Pagination-Limit, X-Pagination-Item-Count, X-Pagination-Page-Count",
  };
  await page.route("https://auth.trakt.tv/oauth/authorize**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    expect(request.method()).toBe("GET");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(APP_URL);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.searchParams.has("code_verifier")).toBe(false);
    const state = url.searchParams.get("state")!;
    const challenge = url.searchParams.get("code_challenge")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    result.states.push(state); result.challenges.push(challenge);
    const callback = new URL(APP_URL);
    callback.search = new URLSearchParams({ code: AUTHORIZATION_CODE, state: result.badState ? `wrong-${state}` : state }).toString();
    // Playwright only routes the first URL in an HTTP redirect chain. A fresh
    // document navigation also intercepts the callback instead of reaching the live site.
    await route.fulfill({ status: 200, contentType: "text/html", body: `<script>window.location.replace(${JSON.stringify(callback.href)})</script>` });
  });
  await page.route("https://auth.trakt.tv/oauth/token", async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    result.tokenCalls += 1;
    expect(request.method()).toBe("POST");
    expect(request.headers()["content-type"]).toBe("application/json");
    expect(request.headers()["authorization"]).toBeUndefined();
    expect(request.headers()["cookie"]).toBeUndefined();
    expect(request.headers()["referer"]).toBeUndefined();
    const body = request.postDataJSON() as Record<string, string>;
    if (body.grant_type === "refresh_token") {
      expect(Object.keys(body).sort()).toEqual(["client_id", "grant_type", "redirect_uri", "refresh_token"]);
      expect(body).toEqual({ client_id: CLIENT_ID, grant_type: "refresh_token", redirect_uri: APP_URL, refresh_token: result.refreshToken });
      result.refreshCalls += 1;
      result.accessToken = `test-only-rotated-access-${result.refreshCalls}`;
      result.refreshToken = `test-only-rotated-refresh-${result.refreshCalls}`;
    } else {
      expect(Object.keys(body).sort()).toEqual(["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
      expect(body).toMatchObject({ client_id: CLIENT_ID, code: AUTHORIZATION_CODE, grant_type: "authorization_code", redirect_uri: APP_URL });
      expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      result.verifiers.push(body.code_verifier);
      expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(result.challenges.at(-1));
      expect(await page.evaluate(key => sessionStorage.getItem(key), TRAKT_AUTH_CONTEXT_KEY)).toBeNull();
    }
    await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
      access_token: result.accessToken, refresh_token: result.refreshToken, token_type: "Bearer", created_at: Math.floor(Date.now() / 1_000), expires_in: 604_800,
    }) });
  });
  await page.context().route(isMockPosterUrl, async route => {
    const request = route.request();
    expect(request.resourceType()).toBe("fetch");
    expect(request.headers()["cookie"]).toBeUndefined();
    expect(request.headers()["authorization"]).toBeUndefined();
    expect(request.headers()["referer"]).toBeUndefined();
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": request.headers()["origin"] ?? APP_ORIGIN }, contentType: "image/webp", body: MOCK_WEBP });
  });
  const datasets = traktDatasets();
  await page.route("https://api.trakt.tv/**", async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    const url = new URL(request.url());
    if (PUBLIC_SUMMARIES.has(url.pathname)) {
      result.summaryCalls.push(url.pathname);
      expect(request.method()).toBe("GET");
      expect(url.searchParams.get("extended")).toBe("full");
      expect([...url.searchParams.keys()]).toEqual(["extended"]);
      const authorization = request.headers()["authorization"];
      result.summaryAuthorizations.push(authorization);
      if (authorization !== undefined) expect(authorization).toBe(`Bearer ${result.accessToken}`);
      expect(request.headers()["trakt-api-key"]).toBe(CLIENT_ID);
      expect(request.headers()["trakt-api-version"]).toBe("2");
      expect(request.headers()["cookie"]).toBeUndefined();
      expect(request.headers()["referer"]).toBeUndefined();
      if (result.summaryGate) await result.summaryGate;
      const id = Number(url.pathname.split("/").at(-1));
      await route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({
        title: `Original summary ${id}`, year: 2025, ids: { trakt: id, imdb: SUMMARY_IMDB_IDS[url.pathname] }, images: { poster: [NATIVE_POSTER_URL] },
      }) });
      return;
    }
    result.apiCalls.push(url.pathname);
    expect(ENDPOINTS.some(path => path === url.pathname)).toBe(true);
    expect(request.method()).toBe("GET");
    expect(url.searchParams.get("extended")).toBe("full,images");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("250");
    expect(request.headers()["authorization"]).toBe(`Bearer ${result.accessToken}`);
    expect(request.headers()["trakt-api-key"]).toBe(CLIENT_ID);
    expect(request.headers()["trakt-api-version"]).toBe("2");
    expect(request.headers()["cookie"]).toBeUndefined();
    expect(request.headers()["referer"]).toBeUndefined();
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, AUTHORIZATION_CODE, ...result.verifiers]) expect(url.href).not.toContain(secret);
    if (url.pathname === result.rejectOncePath) {
      result.rejectOncePath = "";
      await route.fulfill({ status: 401, headers: cors, contentType: "application/json", body: JSON.stringify({ error: "private-authorization-body" }) });
      return;
    }
    if (url.pathname === result.failPath) {
      await route.fulfill({ status: 500, headers: cors, contentType: "application/json", body: JSON.stringify({ error: `${ACCESS_TOKEN} private-server-body` }) });
      return;
    }
    const rows = datasets[url.pathname];
    await route.fulfill({ status: 200, contentType: "application/json", headers: {
      ...cors, "X-Pagination-Page": "1", "X-Pagination-Limit": "250",
      "X-Pagination-Item-Count": String(rows.length), "X-Pagination-Page-Count": String(Math.ceil(rows.length / 250)),
    }, body: JSON.stringify(rows) });
  });
  return result;
}
async function authorize(page: Page) {
  await page.getByRole("textbox", { name: "Trakt Client ID", exact: true }).fill(CLIENT_ID);
  await page.getByRole("button", { name: "跳转 Trakt 授权", exact: true }).click();
}

test("旧片单凭公开 Client ID 修复海报，补图期间的新评分感想保留，下次打开自动补图且诊断不含个人资料", async ({ page, context }) => {
  test.setTimeout(60_000);
  const before = originalState();
  const trakt = await mockTrakt(page);
  await openMedia(page, { https: true, seed: before });
  let release!: () => void;
  trakt.summaryGate = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole("textbox", { name: "Trakt Client ID", exact: true }).fill(CLIENT_ID);
  await page.getByRole("button", { name: "修复海报", exact: true }).click();
  await expect.poll(() => trakt.summaryCalls.length).toBe(1);
  expect(trakt.summaryCalls).toEqual(["/movies/1"]);
  expect(trakt.tokenCalls).toBe(0);
  expect(trakt.apiCalls).toEqual([]);

  // A delayed summary must patch the latest entry, not overwrite it with a stale copy.
  await openMediaDetail(page, "原来的片名");
  await page.getByRole("button", { name: "编辑记录与感想", exact: true }).click();
  const form = page.getByRole("form", { name: "影音记录表单", exact: true });
  const thought = "补图期间新写下的感想仍属于我。";
  await form.getByRole("spinbutton", { name: "我的评分", exact: true }).fill("9.5");
  await form.getByRole("textbox", { name: "我的感想", exact: true }).fill(thought);
  await form.getByRole("button", { name: "保存影音记录", exact: true }).click();
  await expect(form).not.toBeVisible();
  release(); trakt.summaryGate = null;
  await expect.poll(async () => (await persisted(page))?.life.media.entries.find(entry => entry.id === "trakt:movie:1")?.poster).toBe(PUBLIC_POSTER_URL);
  const patched = await persisted(page);
  expect(patched?.life.media.entries.find(entry => entry.id === "trakt:movie:1")).toEqual({ ...before.life.media.entries[0], rating: 9.5, thought, poster: PUBLIC_POSTER_URL });
  expect(patched?.life.reading).toEqual(before.life.reading);
  expect(patched?.life.board).toEqual(before.life.board);
  expect(patched?.life.thoughts).toEqual(before.life.thoughts);
  expect(await connectionRecord(page)).toBeNull();
  await closeMediaDetail(page);
  const card = page.locator(".media-title").filter({ hasText: "原来的片名" });
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator("[data-poster-state=loaded]")).toHaveCount(1);
  const image = card.locator("img");
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(2);

  await page.getByRole("button", { name: "检查海报", exact: true }).click();
  await expect(page.locator(".media-poster-diagnostics")).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_ORIGIN });
  await page.getByRole("button", { name: "复制海报诊断", exact: true }).click();
  const diagnostic = await page.evaluate(() => navigator.clipboard.readText());
  expect(diagnostic.length).toBeGreaterThan(0);
  for (const privateValue of ["原来的片名", "自己记下的旧电影", "trakt:movie:1", "manual:kept-movie", PUBLIC_POSTER_URL, CLIENT_ID, ACCESS_TOKEN, REFRESH_TOKEN, thought]) expect(diagnostic).not.toContain(privateValue);
  expect(diagnostic).not.toMatch(/https?:\/\//);

  // Preserve the saved public configuration while simulating another old record without a poster.
  const savedWithoutPoster = (await readPreviewWorkspace(page))!;
  delete savedWithoutPoster.life.media.entries.find(entry => entry.id === "trakt:movie:1")!.poster;
  await writePreviewWorkspace(page, savedWithoutPoster);
  const summaryCalls = trakt.summaryCalls.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect.poll(() => trakt.summaryCalls.length).toBe(summaryCalls + 1);
  await expect.poll(async () => (await persisted(page))?.life.media.entries.find(entry => entry.id === "trakt:movie:1")?.poster).toBe(PUBLIC_POSTER_URL);
  expect(trakt.tokenCalls).toBe(0);
  expect(trakt.states).toEqual([]);
  expect(trakt.summaryAuthorizations.every(value => value === undefined)).toBe(true);
  expect(trakt.apiCalls).toEqual([]);
  expect((await persisted(page))?.life.media.entries.find(entry => entry.id === "trakt:movie:1")).toMatchObject({ rating: 9.5, thought });
  expect(await connectionRecord(page)).toBeNull();
});

test("手动电影保存本人评分和感想，只有实际观看日期形成足迹，人生记忆由明确操作留下", async ({ page }) => {
  await openMedia(page);
  const title = "重看一部让我平静的电影";
  const thought = "以前注意情节，现在更在意人物怎样与自己相处。\n这段感受可以独立留下。";
  await page.getByRole("button", { name: "记一部作品", exact: true }).click();
  const form = page.getByRole("form", { name: "影音记录表单", exact: true });
  await form.getByRole("textbox", { name: "片名", exact: true }).fill(title);
  await form.getByRole("combobox", { name: "观看状态", exact: true }).selectOption("watched");
  await form.getByRole("spinbutton", { name: "我的评分", exact: true }).fill("8.5");
  await form.getByRole("textbox", { name: "我的感想", exact: true }).fill(thought);
  await form.getByRole("button", { name: "保存影音记录", exact: true }).click();
  await expect(form).not.toBeVisible();
  const statusOnly = await persisted(page);
  expect(statusOnly?.life.media.entries[0]).toMatchObject({ title, kind: "movie", status: "watched", rating: 8.5, thought, history: [] });
  expect(statusOnly?.life.board.observations).toEqual([]);
  await closeMediaDetail(page);
  await expect(page.getByLabel("影音概览")).toContainText("观看日0天");
  await openMediaDetail(page, title);
  await page.getByRole("button", { name: "编辑记录与感想", exact: true }).click();
  await expect(form.getByRole("textbox", { name: "我的感想", exact: true })).toHaveValue(thought);
  await form.getByLabel(/^追加一次观看日期/).fill("2025-06-18");
  await form.getByRole("button", { name: "保存影音记录", exact: true }).click();
  await expect(form).not.toBeVisible();
  const dated = await persisted(page);
  expect(dated?.life.media.entries[0].history).toHaveLength(1);
  expect(dated?.life.media.entries[0].history[0].watchedAt).toBe("2025-06-18");
  expect(dated?.life.board.observations).toEqual([]);
  await closeMediaDetail(page);
  await expect(page.getByRole("img", { name: /^2025年各月观看日/ })).toHaveAttribute("aria-label", /6月1天/);
  await expectNoTasks(page);
  await openMediaDetail(page, title);
  await page.getByRole("button", { name: "留在人生看板", exact: true }).click();
  await expect(page.locator(".media-panel")).toContainText("这份影音感受已留在人生看板");
  const remembered = await persisted(page);
  expect(remembered?.life.board.observations).toHaveLength(1);
  expect(remembered?.life.board.observations[0]).toMatchObject({ area: "影音", kind: "feeling", date: "2025-06-18", text: `《${title}》\n${thought}` });
  expect(remembered?.life.media).toEqual(dated?.life.media);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect(page.locator(".life-timeline-content")).toContainText(thought);
  await selectView(page, "影音");
  await openMediaDetail(page, title);
  await expect(page.locator(".media-thought")).toHaveText(thought);
  expect((await persisted(page))?.life).toEqual(remembered?.life);
  await expectNoTasks(page);
});

test("真实浏览器 PKCE 回跳先预览后合并，旧阅读看板感想保留且临时凭据不进入网址、存储或备份", async ({ page }) => {
  test.setTimeout(60_000);
  const before = originalState();
  const trakt = await mockTrakt(page);
  await openMedia(page, { https: true, seed: before });
  const rawBefore = await rawStorage(page);
  await authorize(page);
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  expect(trakt.tokenCalls).toBe(1);
  expect(trakt.apiCalls).toEqual([...ENDPOINTS]);
  expect(await rawStorage(page)).toBe(rawBefore);
  await expect(page.locator(".trakt-preview")).toContainText("5 部作品 · 1 条单集记录 · 2 次有日期的观看 · 3 项本人评分");
  const secrets = [AUTHORIZATION_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ...trakt.states, ...trakt.verifiers];
  await expectAuthorizationCleared(page, secrets);
  await page.getByRole("button", { name: "保存到影音", exact: true }).click();
  await expect(page.locator(".trakt-sync")).toContainText("已启用每次打开网页自动更新");
  const after = await persisted(page);
  expect(after?.life.reading).toEqual(before.life.reading);
  expect(after?.life.board).toEqual(before.life.board);
  expect(after?.life.thoughts).toEqual(before.life.thoughts);
  expect(after?.life.media.entries).toHaveLength(7);
  expect(after?.life.media.entries.find(entry => entry.id === "manual:kept-movie")).toEqual(before.life.media.entries[1]);
  const mergedMovie = after?.life.media.entries.find(entry => entry.id === "trakt:movie:1");
  expect(mergedMovie).toMatchObject({ title: "Original movie 1", rating: 8, thought: before.life.media.entries[0].thought, status: "watched", history: [{ id: "manual:kept-view", watchedAt: "2024-05-06" }, { id: "trakt:history:101", watchedAt: "2025-12-31T18:00:00Z" }] });
  expect(after?.life.media.entries.find(entry => entry.id === "trakt:show:4")).toMatchObject({ status: "unclassified", rating: 7, history: [] });
  expect(after?.life.media.entries.find(entry => entry.id === "trakt:episode:9")).toMatchObject({ showId: "trakt:show:4", season: 1, episode: 2, status: "watched" });
  expect(after?.life.media.entries.find(entry => entry.id === "trakt:movie:8")).toMatchObject({ rating: 0, status: "unclassified", history: [] });
  // The episode's written date is later, but its offset makes the movie the newer viewing.
  await expect(page.locator(".media-recent li").first()).toContainText("Original movie 1");
  await expectNoTasks(page);
  await expectAuthorizationCleared(page, secrets);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const filename = await (await downloadPromise).path();
  expect(filename).not.toBeNull();
  const backupText = await readFile(filename!, "utf8");
  const backup = JSON.parse(backupText);
  expect(backup.life).toEqual(after?.life);
  for (const secret of [...secrets, "private-cdn-image", "9.9"]) expect(backupText).not.toContain(secret);
  const beforeReloadCalls = trakt.apiCalls.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect(page.locator(".trakt-auto-status")).toContainText("影音已自动更新");
  expect(trakt.apiCalls.slice(beforeReloadCalls)).toEqual([...ENDPOINTS]);
  const reloaded = await persisted(page);
  expect(reloaded?.life.media.entries).toEqual(after?.life.media.entries);
  expect(reloaded?.life.reading).toEqual(after?.life.reading);
  expect(reloaded?.life.board).toEqual(after?.life.board);
  expect(reloaded?.life.thoughts).toEqual(after?.life.thoughts);
  await expectAuthorizationCleared(page, secrets);
});

test("浏览器保存 Trakt 连接后默认人生看板自动更新，续期轮换，接口失败保留资料，断开后不再同步", async ({ page }) => {
  test.setTimeout(90_000);
  const before = originalState();
  const trakt = await mockTrakt(page);
  await openMedia(page, { https: true, seed: before });
  await authorize(page);
  await expect(page.getByRole("heading", { name: "已读取，等你确认", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存到影音", exact: true }).click();
  await expect(page.locator(".trakt-sync")).toContainText("已启用每次打开网页自动更新");
  await expect.poll(async () => (await connectionRecord(page))?.session.accessToken).toBe(ACCESS_TOKEN);
  const saved = await persisted(page);
  const secrets = [AUTHORIZATION_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ...trakt.verifiers, ...trakt.states];
  await expectAuthorizationCleared(page, secrets);

  let start = trakt.apiCalls.length;
  await page.reload();
  await expect(page.locator(".trakt-auto-status")).toContainText("影音已自动更新");
  await expect(page.locator(".life-timeline-content")).toBeVisible();
  expect(trakt.apiCalls.slice(start)).toEqual([...ENDPOINTS]);
  expect(trakt.refreshCalls).toBe(0);
  const autoSaved = await persisted(page);
  expect(autoSaved?.life.media.entries).toEqual(saved?.life.media.entries);
  expect(autoSaved?.life.reading).toEqual(before.life.reading);
  expect(autoSaved?.life.board).toEqual(before.life.board);
  expect(autoSaved?.life.thoughts).toEqual(before.life.thoughts);
  expect((await connectionRecord(page))?.syncedAt).toBe(autoSaved?.life.media.syncedAt);

  await expireConnectionSoon(page);
  start = trakt.apiCalls.length;
  await page.reload();
  await expect(page.locator(".trakt-auto-status")).toContainText("影音已自动更新");
  expect(trakt.refreshCalls).toBe(1);
  expect(trakt.apiCalls.slice(start)).toEqual([...ENDPOINTS]);
  expect((await connectionRecord(page))?.session).toMatchObject({ accessToken: trakt.accessToken, refreshToken: trakt.refreshToken });
  expect((await connectionRecord(page))?.session.expiresAt).toBeGreaterThan(Date.now() + 600_000_000);
  secrets.push(trakt.accessToken, trakt.refreshToken);
  await expectAuthorizationCleared(page, secrets);

  // A real API 401 forces one rotation, then retries the complete import once.
  trakt.rejectOncePath = ENDPOINTS[0];
  start = trakt.apiCalls.length;
  await page.reload();
  await expect(page.locator(".trakt-auto-status")).toContainText("影音已自动更新");
  expect(trakt.refreshCalls).toBe(2);
  expect(trakt.apiCalls.slice(start)).toEqual([ENDPOINTS[0], ...ENDPOINTS]);
  secrets.push(trakt.accessToken, trakt.refreshToken);
  const goodRaw = await rawStorage(page);
  const goodConnection = await connectionRecord(page);

  trakt.failPath = ENDPOINTS[3];
  start = trakt.apiCalls.length;
  await page.reload();
  await expect(page.locator(".trakt-auto-status")).toContainText("Trakt 服务暂时无法完成请求");
  expect(trakt.apiCalls.slice(start)).toEqual(ENDPOINTS.slice(0, 4));
  expect(await rawStorage(page)).toBe(goodRaw);
  expect(await connectionRecord(page)).toEqual(goodConnection);
  await expectAuthorizationCleared(page, secrets);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const backup = await readFile((await (await download).path())!, "utf8");
  for (const secret of secrets) expect(backup).not.toContain(secret);

  await selectView(page, "影音");
  await expect(page.locator(".trakt-sync")).toContainText("已连接 · 每次打开网页自动更新");
  await page.getByRole("button", { name: "断开 Trakt 连接", exact: true }).click();
  await expect(page.locator(".trakt-sync")).toContainText("Trakt 连接已从此浏览器移除，影音记录保留");
  expect(await connectionRecord(page)).toBeNull();
  expect(await rawStorage(page)).toBe(goodRaw);
  start = trakt.apiCalls.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect(page.locator(".trakt-auto-status")).toHaveCount(0);
  expect(await connectionRecord(page)).toBeNull();
  expect(trakt.apiCalls.length).toBe(start);
  expect(await rawStorage(page)).toBe(goodRaw);
});

test("错误授权 state 不换令牌，后续接口失败不保存部分资料，原生活数据与凭据清理保持完整", async ({ page }) => {
  test.setTimeout(60_000);
  const trakt = await mockTrakt(page);
  trakt.badState = true;
  await openMedia(page, { https: true, seed: originalState() });
  const before = await rawStorage(page);
  await authorize(page);
  await expect(page.locator(".trakt-sync").getByRole("alert")).toContainText("临时授权信息无效或已过期");
  expect(trakt.tokenCalls).toBe(0);
  expect(trakt.apiCalls).toEqual([]);
  expect(await rawStorage(page)).toBe(before);
  await expect(page.getByRole("button", { name: "保存到影音", exact: true })).toHaveCount(0);
  await expectAuthorizationCleared(page, [AUTHORIZATION_CODE, ...trakt.states]);

  trakt.badState = false;
  trakt.failPath = "/users/me/ratings/shows";
  await authorize(page);
  const error = page.locator(".trakt-sync").getByRole("alert");
  await expect(error).toContainText("Trakt 服务暂时无法完成请求");
  await expect(error).not.toContainText(ACCESS_TOKEN);
  await expect(error).not.toContainText("private-server-body");
  expect(trakt.tokenCalls).toBe(1);
  expect(trakt.apiCalls).toEqual(ENDPOINTS.slice(0, 4));
  expect(await rawStorage(page)).toBe(before);
  await expect(page.getByRole("button", { name: "保存到影音", exact: true })).toHaveCount(0);
  await expectAuthorizationCleared(page, [AUTHORIZATION_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ...trakt.states, ...trakt.verifiers]);
  const publicSummaryStart = trakt.summaryCalls.length;
  const summaryAuthStart = trakt.summaryAuthorizations.length;
  const listCallsBeforeReload = [...trakt.apiCalls];
  const tokenCallsBeforeReload = trakt.tokenCalls;
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect.poll(async () => (await persisted(page))?.life.media.entries.find(entry => entry.id === "trakt:movie:1")?.poster).toBe(PUBLIC_POSTER_URL);
  const repaired = await persisted(page);
  const original = await decodePreviewWorkspace<StoredWorkspace>(before!);
  // Public artwork repair may add only a poster; all existing workspace data stays exact.
  const withoutPosters = (workspace: StoredWorkspace) => ({
    ...workspace,
    life: { ...workspace.life, media: { ...workspace.life.media, entries: workspace.life.media.entries.map(({ poster: _poster, ...entry }) => entry) } },
  });
  expect(withoutPosters(repaired!)).toEqual(withoutPosters(original));
  expect(repaired?.life.media.entries.find(entry => entry.id === "manual:kept-movie")).toEqual(original.life.media.entries[1]);
  expect(trakt.tokenCalls).toBe(tokenCallsBeforeReload);
  expect(trakt.apiCalls).toEqual(listCallsBeforeReload);
  expect(trakt.summaryCalls.slice(publicSummaryStart)).toEqual(["/movies/1"]);
  expect(trakt.summaryAuthorizations.slice(summaryAuthStart)).toEqual([undefined]);
  expect(await connectionRecord(page)).toBeNull();
  await expectAuthorizationCleared(page, [AUTHORIZATION_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ...trakt.states, ...trakt.verifiers]);
});

test("390px 手机中的六个主导航排成一行，长片名与感想保存回看时没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openMedia(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("button")).toHaveCount(6);
  const buttons = await navigation.getByRole("button").all();
  const bounds = await Promise.all(buttons.map(button => button.boundingBox()));
  expect(bounds.every(bound => bound !== null)).toBe(true);
  const top = bounds[0]!.y;
  for (const bound of bounds) {
    expect(Math.abs(bound!.y - top)).toBeLessThanOrEqual(1);
    expect(bound!.x).toBeGreaterThanOrEqual(0);
    expect(bound!.x + bound!.width).toBeLessThanOrEqual(390);
  }
  for (const name of ["人生看板", "阅读", "影音", "思考", "财务", "事务"]) await expect(navigation.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "记一部作品", exact: true }).click();
  const form = page.getByRole("form", { name: "影音记录表单", exact: true });
  const title = `一部很长名字的电影${"long_title_".repeat(35)}`;
  const thought = `故事留下的感受：\n${"允许记忆有自己的节奏。".repeat(100)}\n${"b".repeat(2200)}`;
  await form.getByRole("textbox", { name: "片名", exact: true }).fill(title);
  await form.getByRole("textbox", { name: "我的感想", exact: true }).fill(thought);
  await form.getByRole("spinbutton", { name: "我的评分", exact: true }).fill("0");
  await expectNoHorizontalOverflow(page);
  await form.getByRole("button", { name: "保存影音记录", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect((await persisted(page))?.life.media.entries[0]).toMatchObject({ title, thought, rating: 0, status: "wanted", history: [] });
  await openMediaDetail(page, title);
  await page.getByRole("button", { name: "编辑记录与感想", exact: true }).click();
  await expect(form.getByRole("textbox", { name: "我的感想", exact: true })).toHaveValue(thought);
  await expectNoHorizontalOverflow(page);
  await form.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await selectView(page, "影音");
  await openMediaDetail(page, title);
  await expect(page.locator(".media-thought")).toHaveText(thought);
  await expectNoHorizontalOverflow(page);
  await expectNoTasks(page);
  await page.screenshot({ path: "/tmp/life-media-mobile.png", fullPage: true });
});


test("多季单集投影为一部剧，上海观看日去重，折叠记录可编辑且原始资料保持完整", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seed = originalState();
  const title = "沿途的生活";
  const parent = { id: "manual:series", kind: "show" as const, title, genres: ["drama"], status: "watching" as const, rating: 8, thought: "整部剧自己的评分与感想。", history: [] };
  const episodes = [
    { id: "manual:s1e1", kind: "episode" as const, title: "抵达之前", showId: parent.id, season: 1, episode: 1, genres: [], status: "watched" as const, rating: 1, thought: "第一集的独立感想。", history: [{ id: "view:1", watchedAt: "2025-06-17T16:30:00Z" }, { id: "view:1-again", watchedAt: "2025-06-18T03:00:00Z" }] },
    { id: "manual:s1e2", kind: "episode" as const, title: "雨中的告别", showId: parent.id, season: 1, episode: 2, genres: [], status: "watched" as const, rating: 2, thought: "第二集的独立感想。", history: [{ id: "view:2", watchedAt: "2025-06-18T12:00:00Z" }] },
    { id: "manual:s2e1", kind: "episode" as const, title: "再次出发", showId: parent.id, season: 2, episode: 1, genres: [], status: "watched" as const, rating: 3, thought: "第二季的独立感想。", history: [{ id: "view:3", watchedAt: "2025-06-18T16:30:00Z" }] },
  ];
  seed.life.media.entries = [parent, ...episodes];
  await openMedia(page, { seed });
  const rawBefore = await rawStorage(page);
  await expect(page.getByRole("dialog", { name: "影音详情" })).not.toBeVisible();
  await expect(page.locator(".media-recent li .media-title")).toHaveCount(1);
  await expect(page.locator(".media-recent li")).toContainText(title);
  await expect(page.getByLabel("影音概览")).toContainText("看过剧集1部");
  await expect(page.getByLabel("影音概览")).toContainText("观看日2天");
  await expect(page.getByRole("img", { name: /^2025年各月观看日/ })).toHaveAttribute("aria-label", /6月2天/);
  await expectNoHorizontalOverflow(page);
  await page.locator(".media-settings > summary").click();
  await page.screenshot({ path: "/tmp/life-media-review-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "片单", exact: true }).click();
  await expect(page.locator(".media-title")).toHaveCount(1);
  await expect(page.locator(".media-title")).toContainText("我的评分 8/10");
  await expect(page.getByLabel("筛选影音类型").locator("option[value=episode]")).toHaveCount(0);
  await page.getByRole("textbox", { name: "搜索影音", exact: true }).fill("雨中的告别");
  await expect(page.locator(".media-title")).toHaveCount(1);
  await expect(page.locator(".media-title")).toContainText(title);
  const detail = await openMediaDetail(page, title);
  await expect(detail.locator(".media-own-rating")).toContainText("8");
  const seasons = detail.locator("details").filter({ has: page.locator("summary", { hasText: /^分季观看记录/ }) }).first();
  await expect(seasons).not.toHaveAttribute("open", "");
  await expect(detail.getByRole("button", { name: "编辑第 1 季第 1 集", exact: true })).not.toBeVisible();
  await seasons.locator(":scope > summary").click();
  const firstSeason = seasons.locator("details").filter({ has: page.locator("summary", { hasText: /^第 1 季/ }) }).first();
  const secondSeason = seasons.locator("details").filter({ has: page.locator("summary", { hasText: /^第 2 季/ }) }).first();
  await expect(firstSeason).not.toHaveAttribute("open", "");
  await expect(secondSeason).not.toHaveAttribute("open", "");
  await firstSeason.locator(":scope > summary").click();
  await expect(firstSeason).toContainText("抵达之前");
  await expect(firstSeason).toContainText("第一集的独立感想。");
  await expect(firstSeason.locator("time[datetime]" )).toHaveCount(3);
  await expect(firstSeason.locator('time[datetime="2025-06-17T16:30:00Z"]')).toBeVisible();
  await secondSeason.locator(":scope > summary").click();
  await expect(secondSeason).toContainText("再次出发");
  await expect(secondSeason).toContainText("第二季的独立感想。");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/life-media-series-mobile.png" });
  expect(await rawStorage(page)).toBe(rawBefore);
  await detail.getByRole("button", { name: "编辑第 1 季第 1 集", exact: true }).click();
  await expect(detail).not.toBeVisible();
  const form = page.getByRole("form", { name: "影音记录表单", exact: true });
  await expect(form.getByRole("textbox", { name: "片名", exact: true })).toHaveValue(episodes[0].title);
  await expect(form.getByRole("spinbutton", { name: "我的评分", exact: true })).toHaveValue("1");
  await form.getByRole("spinbutton", { name: "我的评分", exact: true }).fill("4.5");
  await form.getByRole("textbox", { name: "我的感想", exact: true }).fill("只更新第一集的感想。");
  await form.getByRole("button", { name: "保存影音记录", exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(title);
  const saved = await persisted(page);
  expect(saved?.life.media.entries).toEqual([parent, { ...episodes[0], rating: 4.5, thought: "只更新第一集的感想。" }, episodes[1], episodes[2]]);
  await expect(detail.locator(".media-own-rating")).toContainText("8");
  await expectNoHorizontalOverflow(page);
  await closeMediaDetail(page);
  await page.getByRole("textbox", { name: "搜索影音", exact: true }).fill("");
  await page.getByRole("button", { name: "感想", exact: true }).click();
  await expect(page.locator(".media-feeling-card")).toHaveCount(1);
  await expect(page.locator(".media-feeling-card")).toContainText(title);
  await expect(page.locator(".media-feeling-card")).toContainText("只更新第一集的感想。");
  await expectNoTasks(page);
});

test("海报从官方来源缓存为Blob，同一图片不重复下载，刷新复用缓存，失败可重试且备份不含图片内容", async ({ page, context }) => {
  const before = originalState();
  const poster = NATIVE_POSTER_URL;
  const retryPoster = FAILED_POSTER_URL;
  before.life.media.entries[0].poster = poster;
  before.life.media.entries[1].poster = poster;
  before.life.media.entries.push({ id: "manual:retry-poster", kind: "movie", title: "可重试海报的电影", genres: [], status: "wanted", history: [], poster: retryPoster });
  const image = Buffer.from("UklGRi4AAABXRUJQVlA4ICIAAABQAQCdASoCAAMAAUAmJQBOgC6gAP7wxASMNGvr1093/cAA", "base64");
  const downloads: Record<string, number> = {};
  let allowRetry = false;
  await context.route("https://media.trakt.tv/**", async route => {
    const request = route.request();
    const url = request.url();
    expect(request.resourceType()).toBe("fetch");
    expect(request.headers()["cookie"]).toBeUndefined();
    expect(request.headers()["authorization"]).toBeUndefined();
    expect(request.headers()["referer"]).toBeUndefined();
    downloads[url] = (downloads[url] ?? 0) + 1;
    if (url === retryPoster && !allowRetry) {
      await route.fulfill({ status: 500, headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:3200" }, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:3200" }, contentType: "image/webp", body: image });
  });
  await openMedia(page, { seed: before });
  const rawBefore = await rawStorage(page);
  await page.getByRole("button", { name: "片单", exact: true }).click();
  const loaded = page.locator(".media-title .media-title-art img");
  await expect(loaded).toHaveCount(2);
  await page.locator(".media-title").filter({ hasText: "可重试海报的电影" }).scrollIntoViewIfNeeded();
  await expect(page.locator("[data-poster-failed]")).toHaveCount(1);
  expect(downloads[poster]).toBe(1);
  expect(downloads[retryPoster]).toBeGreaterThanOrEqual(1);
  const failedDownloads = downloads[retryPoster];
  for (const img of await loaded.all()) {
    expect(await img.getAttribute("src")).toMatch(/^blob:/);
    await expect.poll(() => img.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(2);
  }
  await openMediaDetail(page, "原来的片名");
  const detailImage = page.getByRole("dialog", { name: "影音详情" }).locator(".media-title-art img");
  await expect(detailImage).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => detailImage.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(2);
  expect(downloads[poster]).toBe(1);
  await closeMediaDetail(page);
  expect(await rawStorage(page)).toBe(rawBefore);
  allowRetry = true;
  await page.getByRole("button", { name: "修复海报", exact: true }).click();
  await expect(page.locator("[data-poster-failed]")).toHaveCount(0);
  await expect(loaded).toHaveCount(3);
  expect(downloads[poster]).toBe(1);
  expect(downloads[retryPoster]).toBe(failedDownloads + 1);
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await selectView(page, "影音");
  await page.getByRole("button", { name: "片单", exact: true }).click();
  await expect(loaded).toHaveCount(3);
  expect(downloads[poster]).toBe(1);
  expect(downloads[retryPoster]).toBe(failedDownloads + 1);
  expect(await rawStorage(page)).toBe(rawBefore);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const file = await download;
  const backupText = await readFile((await file.path())!, "utf8");
  const backup = JSON.parse(backupText);
  expect(backup.life.media.entries[0].poster).toBe(poster);
  expect(backupText).not.toContain("blob:");
  expect(backupText).not.toContain(image.toString("base64"));
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.locator(".feedback")).toContainText("海报缓存已清空");
  const cached = await page.evaluate(async () => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open("life-workbench-public-posters", 1);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("posters");
      const count = tx.objectStore("posters").count();
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
      tx.oncomplete = () => db.close();
    };
    request.onerror = () => reject(request.error);
  }));
  expect(cached).toBe(0);
});
