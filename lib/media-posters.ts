import { normalizeMediaPoster } from "./media";

export const MAX_POSTER_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const IMAGE_TYPES = new Set(["image/webp", "image/jpeg", "image/png"]);

export interface MediaPosterCache {
  get(url: string): Promise<Blob | undefined>;
  set(url: string, blob: Blob): Promise<void>;
  delete(url: string): Promise<void>;
  clear(): Promise<void>;
}

/** This database contains only public poster URLs, image blobs and access times. */
function browserPosterCache(): MediaPosterCache {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
        const request = indexedDB.open("life-workbench-public-posters", 1);
        let expired = false;
        const timeout = setTimeout(() => { expired = true; reject(new Error("Poster cache timeout")); }, 2_000);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("posters", { keyPath: "url" });
          store.createIndex("accessedAt", "accessedAt");
        };
        request.onsuccess = () => {
          clearTimeout(timeout);
          if (expired) return request.result.close();
          request.result.onversionchange = () => { request.result.close(); database = undefined; };
          resolve(request.result);
        };
        request.onerror = () => { clearTimeout(timeout); reject(request.error); };
      });
      // Retry on a later request if browser storage was temporarily unavailable.
      void database.catch(() => { database = undefined; });
    }
    return database;
  };
  async function transaction<T>(work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("posters", "readwrite");
      let value: T;
      const timeout = setTimeout(() => { tx.abort(); }, 2_000);
      tx.oncomplete = () => { clearTimeout(timeout); resolve(value); };
      tx.onabort = tx.onerror = () => { clearTimeout(timeout); reject(tx.error ?? new Error("Poster cache unavailable")); };
      work(tx.objectStore("posters"), next => { value = next; });
    });
  }
  return {
    get: url => transaction<Blob | undefined>((store, result) => {
      const request = store.get(url);
      request.onsuccess = () => {
        const record = request.result as { blob?: Blob; accessedAt: number } | undefined;
        if (record?.blob instanceof Blob && validBlob(record.blob)) {
          store.put({ url, blob: record.blob, accessedAt: Date.now() });
          result(record.blob);
        } else { if (record) store.delete(url); result(undefined); }
      };
    }),
    set: (url, blob) => transaction<void>((store, result) => {
      store.put({ url, blob, accessedAt: Date.now() });
      const count = store.count();
      count.onsuccess = () => {
        let remaining = count.result - MAX_CACHE_ENTRIES;
        if (remaining > 0) {
          const cursor = store.index("accessedAt").openCursor();
          cursor.onsuccess = () => {
            if (cursor.result && remaining-- > 0) { cursor.result.delete(); cursor.result.continue(); }
          };
        }
        result(undefined);
      };
    }),
    delete: url => transaction<void>((store, result) => { store.delete(url); result(undefined); }),
    clear: () => transaction<void>((store, result) => { store.clear(); result(undefined); }),
  };
}

function validBlob(blob: Blob): boolean {
  return IMAGE_TYPES.has(blob.type.toLowerCase()) && blob.size > 0 && blob.size <= MAX_POSTER_BYTES;
}

export function createMediaPosterLoader(options: {
  cache?: MediaPosterCache;
  timeoutMs?: number;
} = {}) {
  const cache = options.cache ?? browserPosterCache();
  const memory = new Map<string, Blob>();
  const inflight = new Map<string, Promise<Blob>>();
  const waiting: Array<() => void> = [];
  const controllers = new Set<AbortController>();
  let generation = 0;
  let active = 0;
  let clearing: Promise<void> | undefined;
  async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= 3) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  function remember(url: string, blob: Blob) {
    memory.delete(url);
    memory.set(url, blob);
    if (memory.size > MAX_CACHE_ENTRIES) memory.delete(memory.keys().next().value!);
  }
  async function download(url: string): Promise<Blob> {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      // Call as a global method: native browser fetch requires its proper receiver.
      const response = await globalThis.fetch(url, {
        mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
        redirect: "error", signal: controller.signal,
      });
      if (!response.ok || response.type === "opaque") throw new Error("海报下载失败");
      const imageType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
      if (!IMAGE_TYPES.has(imageType)) {
        throw new Error("海报格式不正确");
      }
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_POSTER_BYTES) throw new Error("海报文件过大");
      if (!response.body) throw new Error("海报内容为空");
      const reader = response.body.getReader();
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_POSTER_BYTES) throw new Error("海报文件过大");
          parts.push(new Uint8Array(value));
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const blob = new Blob(parts, { type: imageType });
      if (!validBlob(blob)) throw new Error("海报内容无效");
      return blob;
    } finally { clearTimeout(timeout); controllers.delete(controller); controller.abort(); }
  }
  function load(url: string): Promise<Blob> {
    if (clearing) return Promise.reject(new Error("海报缓存正在清空"));
    const safeUrl = normalizeMediaPoster(url);
    if (!safeUrl) return Promise.reject(new Error("海报地址不正确"));
    const remembered = memory.get(safeUrl);
    if (remembered) { remember(safeUrl, remembered); return Promise.resolve(remembered); }
    const existing = inflight.get(safeUrl);
    if (existing) return existing;
    const requestGeneration = generation;
    const ensureCurrent = () => {
      if (requestGeneration !== generation) throw new Error("海报请求已取消");
    };
    const request = withSlot(async () => {
      ensureCurrent();
      let blob: Blob | undefined;
      try { blob = await cache.get(safeUrl); } catch { /* Storage is optional. */ }
      ensureCurrent();
      if (!blob || !validBlob(blob)) {
        blob = await download(safeUrl);
        ensureCurrent();
        try { await cache.set(safeUrl, blob); } catch { /* Display the downloaded blob even if storage is full. */ }
      }
      ensureCurrent();
      remember(safeUrl, blob);
      return blob;
    });
    inflight.set(safeUrl, request);
    void request.finally(() => { inflight.delete(safeUrl); }).catch(() => {});
    return request;
  }
  async function invalidate(url: string): Promise<void> {
    const safeUrl = normalizeMediaPoster(url);
    if (!safeUrl) return;
    try { await inflight.get(safeUrl); } catch { /* Failed downloads can be retried. */ }
    memory.delete(safeUrl);
    try { await cache.delete(safeUrl); } catch { /* Storage is optional. */ }
  }
  function clear(): Promise<void> {
    if (clearing) return clearing;
    generation++;
    for (const controller of controllers) controller.abort();
    clearing = (async () => {
      await Promise.allSettled([...inflight.values()]);
      memory.clear();
      try { await cache.clear(); } catch { /* Storage may be unavailable. */ }
    })().finally(() => { clearing = undefined; });
    return clearing;
  }
  return { load, invalidate, clear };
}

const posters = createMediaPosterLoader();
export const loadMediaPoster = posters.load;
export const invalidateMediaPoster = posters.invalidate;

export const clearMediaPosterCache = posters.clear;
