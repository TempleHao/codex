/* Cache only public, documented poster endpoints. Opaque responses remain unreadable to JavaScript. */
const CACHE_NAME = "life-workbench-public-posters-opaque-v1";
const endpoint = new URL("media-poster-cache", self.registration.scope);
const pending = new Map();
const versions = new Map();
const controllers = new Map();
let generation = 0;
let active = 0;
const waiting = [];
let mutations = Promise.resolve();
function serialize(work) {
  const next = mutations.then(work);
  mutations = next.catch(() => {});
  return next;
}
function normalize(value) {
  if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u0020\u007f]/u.test(value)) return;
  if (/^https:\/\/images\.metahub\.space\/poster\/medium\/tt\d{5,12}\/img$/.test(value)) return value;
  try {
    const url = new URL(value.startsWith("walter-r2.trakt.tv/") ? `https://${value}` : value);
    if (url.protocol !== "https:" || url.hostname !== "walter-r2.trakt.tv" || url.username || url.password || url.port || url.search || url.hash) return;
    if (!/^\/images\/[a-z0-9/_-]+\.(?:jpg|jpeg|png)\.webp$/i.test(url.pathname) || url.pathname.includes("//")) return;
    return url.href;
  } catch { return; }
}
function keyFor(url) {
  const key = new URL(endpoint);
  key.searchParams.set("url", url);
  return key.href;
}
async function withSlot(work) {
  if (active >= 3) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}
function load(url) {
  if (pending.has(url)) return pending.get(url);
  const epoch = generation;
  const version = versions.get(url);
  const current = () => {
    if (epoch !== generation || version !== versions.get(url)) throw new Error("Poster request cancelled");
  };
  const request = withSlot(async () => {
    current();
    const cache = await caches.open(CACHE_NAME);
    const key = keyFor(url);
    const cached = await cache.match(key);
    current();
    if (cached) return cached;
    const controller = new AbortController();
    controllers.set(url, controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      // Browsers require redirect:follow for no-cors. The initial URL is trusted;
      // an opaque response does not expose its final redirect URL for inspection.
      const response = await fetch(url, { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow", signal: controller.signal });
      current();
      if (response.type !== "opaque") throw new Error("Expected a public opaque image");
      // Opaque bodies cannot be inspected or size-checked; bound their storage by entry count.
      await serialize(async () => {
        current();
        await cache.put(key, response.clone());
        const keys = await cache.keys();
        for (const oldest of keys.slice(0, Math.max(0, keys.length - 12))) await cache.delete(oldest);
      });
      current();
      return response;
    } finally {
      clearTimeout(timeout);
      if (controllers.get(url) === controller) controllers.delete(url);
    }
  });
  pending.set(url, request);
  void request.finally(() => { if (pending.get(url) === request) pending.delete(url); }).catch(() => {});
  return request;
}
self.addEventListener("install", event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", event => {
  const request = event.request;
  const target = new URL(request.url);
  if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname || request.method !== "GET" || request.destination !== "image" || request.mode !== "no-cors") return;
  const values = target.searchParams.getAll("url");
  const url = values.length === 1 && [...target.searchParams.keys()].length === 1 ? normalize(values[0]) : undefined;
  event.respondWith(url ? load(url).then(response => response.clone()).catch(() => Response.error()) : Promise.resolve(Response.error()));
});
self.addEventListener("message", event => {
  const data = event.data;
  if (!event.source || new URL(event.source.url).origin !== endpoint.origin || !data) return;
  if (data.type === "version") { event.ports[0]?.postMessage({ version: 2 }); return; }
  if (!["clear", "delete"].includes(data.type)) return;
  const url = data.type === "delete" ? normalize(data.url) : undefined;
  if (data.type === "delete" && !url) return;
  if (data.type === "clear") {
    generation++;
    for (const controller of controllers.values()) controller.abort();
    pending.clear();
    versions.clear();
  } else {
    versions.set(url, (versions.get(url) || 0) + 1);
    controllers.get(url)?.abort();
    pending.delete(url);
  }
  const task = serialize(async () => {
    if (data.type === "clear") await caches.delete(CACHE_NAME);
    else { const cache = await caches.open(CACHE_NAME); await cache.delete(keyFor(url)); }
  });
  event.waitUntil(task.then(() => event.ports[0]?.postMessage({ ok: true }), () => event.ports[0]?.postMessage({ ok: false })));
});
