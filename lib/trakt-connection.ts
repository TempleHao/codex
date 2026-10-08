import { z } from "zod";
import { refreshTraktSession, traktSessionSchema, TraktError, type TraktSession, type TraktRequestOptions } from "./trakt";

// Kept separate from application state, exports, localStorage and sessionStorage.
const DATABASE = "life-workbench-trakt-connection-v1";
const STORE = "connection";
const LOCK = "life-workbench:trakt-connection";
const recordSchema = z.object({ session: traktSessionSchema, syncedAt: z.iso.datetime({ offset: true }).nullable() }).strict();
export interface TraktConnectionRecord { session: TraktSession; syncedAt: string | null }
export interface TraktConnectionStore {
  read(): Promise<unknown>;
  write(record: TraktConnectionRecord | null): Promise<void>;
}
interface ConnectionLocks { request<T>(name: string, callback: () => Promise<T>): Promise<T> }
const storageError = () => new TraktError("浏览器无法保存 Trakt 连接，请允许本站使用浏览器本地存储。", "storage");

function browserStore(): TraktConnectionStore {
  async function database(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") throw storageError();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(storageError());
      request.onblocked = () => reject(storageError());
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  return {
    async read() {
      const db = await database();
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const request = tx.objectStore(STORE).get("active");
          tx.oncomplete = () => resolve(request.result ?? null);
          tx.onerror = tx.onabort = () => reject(storageError());
        });
      } finally { db.close(); }
    },
    async write(record) {
      const db = await database();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          if (record) tx.objectStore(STORE).put(record, "active");
          else tx.objectStore(STORE).delete("active");
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(storageError());
        });
      } finally { db.close(); }
    },
  };
}
export interface TraktValidSessionOptions extends TraktRequestOptions {
  forceRefresh?: boolean;
  /** Access token rejected by an API request, so a concurrent rotation need not refresh twice. */
  rejectedAccessToken?: string;
}
export function createTraktConnection(dependencies: { store?: TraktConnectionStore; locks?: ConnectionLocks | null; now?: () => number } = {}) {
  const store = dependencies.store ?? browserStore();
  const now = dependencies.now ?? Date.now;
  const locks = () => dependencies.locks === undefined ? (typeof navigator !== "undefined" ? navigator.locks : undefined) : dependencies.locks;
  let generation = 0;
  let flight: Promise<TraktSession | null> | null = null;
  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    const manager = locks();
    return manager ? manager.request(LOCK, operation) : operation();
  }
  async function read(): Promise<TraktConnectionRecord | null> {
    let raw: unknown;
    try { raw = await store.read(); } catch { throw storageError(); }
    if (raw == null) return null;
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) throw new TraktError("Trakt 连接信息无效，请重新连接。", "reauthorization");
    return parsed.data;
  }
  async function write(record: TraktConnectionRecord | null) {
    try { await store.write(record); } catch { throw storageError(); }
  }
  async function save(session: TraktSession) {
    const parsed = traktSessionSchema.safeParse(session);
    if (!parsed.success) throw new TraktError("Trakt 连接信息无效，请重新连接。", "reauthorization");
    const revision = ++generation;
    await locked(async () => { if (revision === generation) await write({ session: parsed.data, syncedAt: null }); });
  }
  async function disconnect() {
    ++generation;
    await locked(() => write(null));
  }
  async function markSynced(syncedAt: string, accessToken?: string) {
    if (!recordSchema.shape.syncedAt.safeParse(syncedAt).success) throw new TraktError("Trakt 同步时间无效。");
    const revision = generation;
    await locked(async () => {
      const record = await read();
      if (record && revision === generation && (!accessToken || record.session.accessToken === accessToken)) await write({ ...record, syncedAt });
    });
  }
  function getValidSession(options: TraktValidSessionOptions = {}): Promise<TraktSession | null> {
    if (flight) return flight;
    const revision = generation;
    const promise = locked(async () => {
      if (revision !== generation) return null;
      const record = await read();
      if (!record) return null;
      const session = record.session;
      const currentTime = options.now ?? now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) throw new TraktError("Trakt 请求设置不正确。");
      const forced = options.forceRefresh && (!options.rejectedAccessToken || options.rejectedAccessToken === session.accessToken);
      if (!forced && session.expiresAt > currentTime + 60_000) return session;
      // Without a cross-tab lock a single-use refresh may invalidate another tab's session.
      if (!locks()) throw new TraktError("此浏览器无法安全自动续期 Trakt 连接，请重新连接或使用支持 Web Locks 的浏览器。", "refresh-lock");
      let rotated: TraktSession;
      try { rotated = await refreshTraktSession(session, { ...options, now: currentTime }); }
      catch (error) {
        if (revision === generation && error instanceof TraktError && (error.code === "reauthorization" || error.code === "unauthorized")) await write(null);
        throw error;
      }
      // A disconnect/new authorization invoked during the HTTP request wins.
      if (revision !== generation) return null;
      await write({ ...record, session: rotated });
      return rotated;
    });
    flight = promise;
    void promise.finally(() => { if (flight === promise) flight = null; }).catch(() => {});
    return promise;
  }
  return { read, save, disconnect, markSynced, getValidSession };
}
export const traktConnection = createTraktConnection();
