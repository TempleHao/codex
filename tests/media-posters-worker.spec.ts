import { expect, test } from "@playwright/test";
import { emptyLifeData } from "../lib/life";

const CACHE = "life-workbench-public-posters-opaque-v1";
const POSTER = "https://walter-r2.trakt.tv/images/movies/001/posters/thumb/public.jpg.webp";
const IMAGE = Buffer.from("UklGRi4AAABXRUJQVlA4ICIAAABQAQCdASoCAAMAAUAmJQBOgC6gAP7wxASMNGvr1093/cAA", "base64");

test("CORS拒绝后以同源SW地址显示opaque公共海报，刷新复用并可清空", async ({ page, context }) => {
  let corsRequests = 0;
  let opaqueDownloads = 0;
  const corsFailures: string[] = [];
  page.on("requestfailed", request => {
    if (request.url() === POSTER) corsFailures.push(request.failure()?.errorText ?? "");
  });
  // Context routing also handles worker-owned fetches. Explicitly mismatch
  // ACAO because Playwright otherwise adds the request origin on fulfillment.
  await context.route("https://walter-r2.trakt.tv/**", async route => {
    const request = route.request();
    const headers = await request.allHeaders();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    if (request.serviceWorker()) opaqueDownloads++;
    else corsRequests++;
    await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "https://unrelated.example" }, contentType: "image/webp", body: IMAGE });
  });
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  const life = emptyLifeData();
  life.media.entries = [{ id: "manual:public-poster", title: "公共海报测试", kind: "movie", genres: [], status: "wanted", history: [], poster: POSTER }];
  await page.evaluate(state => {
    localStorage.setItem("life-workbench-preview-v1", JSON.stringify(state));
  }, { version: 1, tasks: [], sources: [], batches: {}, life });
  await page.reload();
  const openMedia = async () => {
    await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^影音/ }).click();
    await page.locator(".media-title").click();
  };
  await openMedia();
  const images = page.locator(".media-title-art img");
  await expect(images).toHaveCount(2);
  await expect.poll(async () => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth === 2))).toBe(true);
  for (const image of await images.all()) {
    const source = new URL((await image.getAttribute("src"))!);
    expect(source.origin).toBe(new URL(page.url()).origin);
    expect(source.pathname).toBe(new URL("media-poster-cache", page.url()).pathname);
    expect(source.searchParams.get("url")).toBe(POSTER);
  }
  expect(corsRequests).toBeGreaterThanOrEqual(1);
  expect(corsFailures.length).toBeGreaterThan(0);
  expect(opaqueDownloads).toBe(1);
  expect(await page.evaluate(async name => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const response = await cache.match(keys[0]);
    return { count: keys.length, type: response?.type, status: response?.status, bytes: (await response?.blob())?.size };
  }, CACHE)).toEqual({ count: 1, type: "opaque", status: 0, bytes: 0 });
  await page.reload();
  await openMedia();
  await expect(images).toHaveCount(2);
  await expect.poll(async () => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth === 2))).toBe(true);
  expect(opaqueDownloads).toBe(1);
  await page.getByRole("button", { name: "关闭影音详情", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.locator(".feedback")).toContainText("海报缓存已清空");
  expect(await page.evaluate(name => caches.has(name), CACHE)).toBe(false);
});
