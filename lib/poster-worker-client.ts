import { normalizeMediaPoster } from "./media";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const scope = `${basePath.replace(/\/$/, "")}/`;
let workerReady: Promise<ServiceWorker> | undefined;

function ensureWorker(): Promise<ServiceWorker> {
  if (workerReady) return workerReady;
  workerReady = new Promise<ServiceWorker>((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return reject(new Error("海报缓存不可用"));
    const script = new URL(`${scope}media-posters-worker.js`, location.origin).href;
    const expectedScope = new URL(scope, location.origin).href;
    let registration: ServiceWorkerRegistration | undefined;
    const probes = new Map<ServiceWorker, MessagePort>();
    const ownedController = () => {
      const controller = navigator.serviceWorker.controller;
      return controller?.scriptURL === script ? controller : undefined;
    };
    const cleanup = () => {
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      for (const port of probes.values()) port.close();
      probes.clear();
    };
    const changed = () => {
      const worker = ownedController();
      if (!worker || registration?.active?.scriptURL !== script || probes.has(worker)) return;
      // An old controller shares this script URL but cannot serve the new poster host.
      // Wait for the updated controller to acknowledge the supported protocol.
      const channel = new MessageChannel();
      probes.set(worker, channel.port1);
      channel.port1.onmessage = event => {
        if (event.data?.version !== 2 || ownedController() !== worker) return;
        cleanup(); resolve(worker);
      };
      try { worker.postMessage({ type: "version" }, [channel.port2]); }
      catch { channel.port1.close(); probes.delete(worker); }
    };
    const timeout = setTimeout(() => { cleanup(); reject(new Error("海报缓存启动超时")); }, 10000);
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    void (async () => {
      // Avoid replacing an unrelated worker at the same scope.
      const existing = await navigator.serviceWorker.getRegistration(expectedScope);
      if (existing && [existing.active, existing.waiting, existing.installing].some(worker => worker && worker.scriptURL !== script)) {
        throw new Error("网站已有其它离线缓存");
      }
      registration = await navigator.serviceWorker.register(script, { scope, updateViaCache: "none" });
      changed();
      registration.addEventListener("updatefound", () => registration?.installing?.addEventListener("statechange", changed));
    })().catch(error => { cleanup(); reject(error); });
  });
  void workerReady.catch(() => { workerReady = undefined; });
  return workerReady;
}

export async function loadPosterWorkerSource(url: string): Promise<string> {
  const safe = normalizeMediaPoster(url);
  if (!safe) throw new Error("海报地址不正确");
  await ensureWorker();
  const source = new URL(`${scope}media-poster-cache`, location.origin);
  source.searchParams.set("url", safe);
  return source.href;
}

async function message(type: "delete" | "clear", url?: string): Promise<void> {
  try {
    const worker = await ensureWorker();
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = () => { clearTimeout(timeout); channel.port1.close(); };
      const timeout = setTimeout(() => { finish(); reject(new Error("海报缓存操作超时")); }, 10000);
      channel.port1.onmessage = event => { finish(); if (event.data?.ok) resolve(); else reject(new Error("海报缓存操作失败")); };
      try { worker.postMessage({ type, url }, [channel.port2]); }
      catch (error) { finish(); reject(error); }
    });
  } catch { /* Cache cleanup must not block library management in unsupported browsers. */ }
}
export async function invalidatePosterWorker(url: string): Promise<void> {
  const safe = normalizeMediaPoster(url);
  if (safe) await message("delete", safe);
}
export async function clearPosterWorkerCache(): Promise<void> { await message("clear"); }
