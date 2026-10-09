import { expect, test } from "@playwright/test";
import { emptyLifeData } from "../lib/life";

const CACHE = "life-workbench-public-posters-opaque-v1";
const POSTER = "https://media.trakt.tv/images/shows/000/312/285/posters/thumb/69c487addb.jpg.webp";
const IMAGE = Buffer.from("UklGRi4AAABXRUJQVlA4ICIAAABQAQCdASoCAAMAAUAmJQBOgC6gAP7wxASMNGvr1093/cAA", "base64");

for (const upgrading of [false, true]) {
test(`CORS拒绝后以同源SW地址显示opaque公共海报，刷新复用并可清空${upgrading ? "（升级旧版Worker）" : ""}`, async ({ page, context }) => {
  let corsRequests = 0;
  let opaqueDownloads = 0;
  const corsFailures: string[] = [];
  page.on("requestfailed", request => {
    if (request.url() === POSTER) corsFailures.push(request.failure()?.errorText ?? "");
  });
  // Context routing also handles worker-owned fetches. Explicitly mismatch
  // ACAO because Playwright otherwise adds the request origin on fulfillment.
  await context.route("https://media.trakt.tv/**", async route => {
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
  if (upgrading) {
    // A deployed version 2 shares the script URL but cannot acknowledge native-host support.
    // The client must wait for version 3 before serving an image through the cache endpoint.
    await context.route("**/media-posters-worker.js", route => route.fulfill({
      contentType: "application/javascript",
      body: 'self.addEventListener("install", e => e.waitUntil(self.skipWaiting())); self.addEventListener("activate", e => e.waitUntil(self.clients.claim())); self.addEventListener("message", e => { if (e.data?.type === "version") e.ports[0]?.postMessage({ version: 2 }); });',
    }));
    await page.evaluate(async () => {
      await navigator.serviceWorker.register(new URL("media-posters-worker.js", location.href).href, { scope: new URL("./", location.href).pathname });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    });
    await context.unroute("**/media-posters-worker.js");
    await page.evaluate(async ({ name, poster }) => {
      // Existing artwork survives the upgrade, including its legacy cache key.
      const response = await fetch(poster, { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer" });
      const key = new URL("media-poster-cache", location.href);
      key.searchParams.set("url", poster.replace("media.trakt.tv", "walter-r2.trakt.tv"));
      await (await caches.open(name)).put(key.href, response);
    }, { name: CACHE, poster: POSTER });
  }
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
  expect(opaqueDownloads).toBe(upgrading ? 0 : 1);
  expect(await page.evaluate(() => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.version); };
    navigator.serviceWorker.controller!.postMessage({ type: "version" }, [channel.port2]);
  }))).toBe(3);
  await page.evaluate(async poster => {
    for (const value of [poster + "?token=secret", poster.replace("media.trakt.tv", "media.trakt.tv.evil.example"), poster.replace("/images/", "/account/")]) {
      const source = new URL("media-poster-cache", location.href);
      source.searchParams.set("url", value);
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => reject(new Error("Unsafe poster URL was accepted"));
        image.onerror = () => resolve();
        image.src = source.href;
      });
    }
  }, POSTER);
  expect(opaqueDownloads).toBe(upgrading ? 0 : 1);
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
  expect(opaqueDownloads).toBe(upgrading ? 0 : 1);
  await page.getByRole("button", { name: "关闭影音详情", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.locator(".feedback")).toContainText("海报缓存已清空");
  expect(await page.evaluate(name => caches.has(name), CACHE)).toBe(false);
});
}
