"use client";

import { useEffect, useRef, useState } from "react";
import { APP_BASE_PATH } from "../lib/client";
import { type ReadingLibrary } from "../lib/reading";
import { decryptReadingLibraryWithKey, MAX_READING_ENVELOPE_BYTES } from "../lib/reading-envelope";
import { readingSyncStatusSchema, type ReadingSyncStatus } from "../lib/reading-sync-status";
import { readingConnection, type createReadingConnection } from "../lib/reading-connection";

export interface WeReadAutoSyncState {
  connected: boolean; busy: boolean; status: ReadingSyncStatus | null;
  statusNote: string; message: string; error: string;
}
export interface WeReadAutoSyncController extends WeReadAutoSyncState {
  refresh(): Promise<void>;
  rememberKey(key: CryptoKey): Promise<void>;
  disconnect(): Promise<void>;
}
/** Bound a same-origin response before parsing; no response body enters errors. */
export async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maximum) throw new Error("ResourceTooLarge");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("ResourceTooLarge");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("ResourceTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function fetchReadingResource(name: "weread-sync.json" | "weread-sync-status.json", signal: AbortSignal): Promise<Response> {
  return fetch(`${APP_BASE_PATH}/${name}`, {
    method: "GET", cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal,
  });
}


/** One startup flight per root mount, including React StrictMode effect replay. */
export function createWeReadAutoSync(options: {
  onImport: (library: ReadingLibrary) => Promise<void>;
  onState: (state: WeReadAutoSyncState) => void;
  connection?: ReturnType<typeof createReadingConnection>;
  fetchResource?: typeof fetchReadingResource;
}) {
  const connection = options.connection ?? readingConnection;
  const fetchResource = options.fetchResource ?? fetchReadingResource;
  let state: WeReadAutoSyncState = { connected: false, busy: false, status: null, statusNote: "", message: "", error: "" };
  let flight: Promise<void> | null = null;
  let startup: Promise<void> | null = null;
  let revision = 0;
  let abort: AbortController | null = null;
  function update(patch: Partial<WeReadAutoSyncState>) { state = { ...state, ...patch }; options.onState(state); }
  function refresh(): Promise<void> {
    if (flight) return flight;
    const run = revision;
    const keyRevision = connection.revision();
    const controller = new AbortController();
    abort = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    update({ busy: true, error: "", message: "" });
    const promise = (async () => {
      // Always check both public resources once; an absent unlock key is normal.
      const key = connection.read().catch(() => {
        if (run === revision) update({ error: "浏览器无法读取自动解锁设置，请重新解锁。" });
        return null;
      });
      const status = (async () => {
        try {
          const response = await fetchResource("weread-sync-status.json", controller.signal);
          if (!response.ok) throw new Error("StatusUnavailable");
          const parsed = readingSyncStatusSchema.parse(JSON.parse(await readBoundedText(response, 10_000)));
          if (run === revision) update({ status: parsed, statusNote: "" });
        } catch {
          if (run === revision) update({ statusNote: "暂时无法查看同步状态，可到 GitHub 查看最近一次运行。" });
        }
      })();
      try {
        const response = await fetchResource("weread-sync.json", controller.signal);
        const material = await key;
        if (run !== revision || keyRevision !== connection.revision()) return;
        update({ connected: !!material });
        if (response.status === 404) { update({ message: "还没有云端快照，请先在 GitHub 完成配置并运行同步。" }); return; }
        if (!response.ok) throw new Error("SnapshotUnavailable");
        const encrypted = await readBoundedText(response, MAX_READING_ENVELOPE_BYTES);
        if (!material) { update({ message: "最新云端快照已检查，请先解锁一次。" }); return; }
        const library = await decryptReadingLibraryWithKey(encrypted, material);
        if (run !== revision || keyRevision !== connection.revision() || controller.signal.aborted) return;
        await options.onImport(library);
        if (run === revision) update({ message: "已自动合并最新云端阅读快照。" });
      } catch {
        if (run === revision) update({ error: "自动更新未完成，请检查网络或重新解锁。现有阅读记录未更改。" });
      } finally {
        await status;
        clearTimeout(timeout);
        if (abort === controller) abort = null;
        if (run === revision) update({ busy: false });
      }
    })();
    flight = promise;
    void promise.finally(() => { if (flight === promise) flight = null; }).catch(() => {});
    return promise;
  }
  return {
    start() { return startup ??= refresh(); },
    refresh,
    async rememberKey(key: CryptoKey) { await connection.save(key); update({ connected: true }); },
    async disconnect() {
      ++revision;
      abort?.abort();
      try {
        await connection.disconnect();
        update({ connected: false, busy: false, message: "已关闭本机自动解锁，现有阅读记录保留。", error: "" });
      } catch {
        const error = "关闭自动解锁未完成，请允许浏览器本地存储后重试。";
        update({ busy: false, error }); throw new Error(error);
      }
    },
    dispose() { ++revision; abort?.abort(); },
  };
}

export function useWeReadAutoSync({ ready, onImport }: {
  ready: boolean; onImport: (library: ReadingLibrary) => Promise<void>;
}): WeReadAutoSyncController {
  const callbackRef = useRef(onImport);
  callbackRef.current = onImport;
  const mountedRef = useRef(false);
  const [state, setState] = useState<WeReadAutoSyncState>({ connected: false, busy: false, status: null, statusNote: "", message: "", error: "" });
  const serviceRef = useRef<ReturnType<typeof createWeReadAutoSync> | null>(null);
  if (!serviceRef.current) serviceRef.current = createWeReadAutoSync({
    onImport: library => callbackRef.current(library),
    onState: next => { if (mountedRef.current) setState(next); },
  });
  const service = serviceRef.current;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Effect replay mounts again synchronously; real unmount cancels the flight.
      queueMicrotask(() => { if (!mountedRef.current) service.dispose(); });
    };
  }, [service]);
  useEffect(() => { if (ready) void service.start(); }, [ready, service]);
  return { ...state, refresh: service.refresh, rememberKey: service.rememberKey, disconnect: service.disconnect };
}
