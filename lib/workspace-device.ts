/** A remembered device key, kept separately from encrypted workspace contents. */
export const DEVICE_TRUST_DATABASE = "life-workbench-device-trust-v1";
export const DEVICE_TRUST_STORE = "trust";
export const DEVICE_TRUST_POLICY_KEY = "life-workbench-device-trust-policy-v1";
export const DEVICE_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const RECORD_KEY = "device";
const LOCK_NAME = "life-workbench-device-trust";
const UNAVAILABLE = "此浏览器暂时无法记住这台设备，请继续使用本次解锁；下次打开仍需输入口令。";
const CHANGED = "设备记忆或锁定状态已改变，未记住这台设备。";

export type DeviceTrust = { id: string; key: CryptoKey; salt: string; createdAt: number; expiresAt: number };
type TrustRecord = { revision: string | null; device: DeviceTrust | null };

function validKey(key: unknown): key is CryptoKey {
  if (typeof key !== "object" || key === null || Object.prototype.toString.call(key) !== "[object CryptoKey]") return false;
  const candidate = key as CryptoKey;
  return candidate.type === "secret" && candidate.extractable === false && candidate.algorithm.name === "AES-GCM" &&
    (candidate.algorithm as AesKeyAlgorithm).length === 256 && candidate.usages.length === 2 &&
    candidate.usages.includes("encrypt") && candidate.usages.includes("decrypt");
}

function validDevice(value: unknown): value is DeviceTrust {
  if (typeof value !== "object" || value === null) return false;
  const device = value as DeviceTrust;
  return typeof device.id === "string" && device.id.length > 0 && validKey(device.key) &&
    typeof device.salt === "string" && /^[A-Za-z0-9+/]{21}[AQgw]==$/.test(device.salt) &&
    Number.isSafeInteger(device.createdAt) && device.createdAt >= 0 && Number.isSafeInteger(device.expiresAt) &&
    device.expiresAt - device.createdAt === DEVICE_TRUST_TTL_MS;
}

function policyStorage(): Storage {
  if (typeof window === "undefined") throw new Error(UNAVAILABLE);
  return window.localStorage;
}

export function deviceTrustAllowed(device: DeviceTrust): boolean {
  try {
    const now = Date.now();
    return validDevice(device) && now >= device.createdAt && now < device.expiresAt &&
      policyStorage().getItem(DEVICE_TRUST_POLICY_KEY) === device.id;
  } catch { return false; }
}

/** Synchronous revocation also protects pages waiting on an IndexedDB transaction. */
export function blockDeviceTrust(): void {
  try { policyStorage().setItem(DEVICE_TRUST_POLICY_KEY, `L:${crypto.randomUUID()}`); }
  catch { throw new Error("浏览器无法取消设备记忆，请允许本地存储后重试。"); }
}

async function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error(UNAVAILABLE);
  return new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(DEVICE_TRUST_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DEVICE_TRUST_STORE);
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
    request.onerror = request.onblocked = () => { rejected = true; reject(new Error(UNAVAILABLE)); };
  });
}

function record(value: unknown): TrustRecord {
  if (value === undefined) return { revision: null, device: null };
  if (typeof value !== "object" || value === null || typeof (value as TrustRecord).revision !== "string" ||
      !(value as TrustRecord).revision) throw new Error(UNAVAILABLE);
  const stored = value as TrustRecord;
  return { revision: stored.revision, device: validDevice(stored.device) ? stored.device : null };
}

export async function readDeviceTrust(): Promise<TrustRecord> {
  const db = await database();
  try {
    return await new Promise<TrustRecord>((resolve, reject) => {
      const transaction = db.transaction(DEVICE_TRUST_STORE, "readonly");
      const request = transaction.objectStore(DEVICE_TRUST_STORE).get(RECORD_KEY);
      transaction.oncomplete = () => {
        try {
          const stored = record(request.result);
          resolve({ revision: stored.revision, device: stored.device && deviceTrustAllowed(stored.device) ? stored.device : null });
        } catch { reject(new Error(UNAVAILABLE)); }
      };
      transaction.onabort = () => reject(new Error(UNAVAILABLE));
    });
  } catch { throw new Error(UNAVAILABLE); }
  finally { db.close(); }
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) throw new Error(UNAVAILABLE);
  return navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, operation);
}

export function rememberDevice(key: CryptoKey, salt: string, expectedRevision: string | null, authorized: () => boolean): Promise<DeviceTrust> {
  return exclusive(async () => {
    if (!authorized()) throw new Error(CHANGED);
    const now = Date.now();
    const device: DeviceTrust = { id: `T:${crypto.randomUUID()}`, key, salt, createdAt: now, expiresAt: now + DEVICE_TRUST_TTL_MS };
    if (!validDevice(device)) throw new Error(UNAVAILABLE);
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(DEVICE_TRUST_STORE, "readwrite", { durability: "strict" });
        const store = transaction.objectStore(DEVICE_TRUST_STORE);
        const request = store.get(RECORD_KEY);
        let failure = UNAVAILABLE;
        request.onsuccess = () => {
          try {
            if (!authorized() || record(request.result).revision !== expectedRevision) { failure = CHANGED; transaction.abort(); return; }
            // Never re-enable this nonce after the asynchronous commit: a lock may have revoked it meanwhile.
            policyStorage().setItem(DEVICE_TRUST_POLICY_KEY, device.id);
            store.put({ revision: device.id, device }, RECORD_KEY);
          } catch { transaction.abort(); }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error(failure));
      });
      if (!authorized() || !deviceTrustAllowed(device)) throw new Error(CHANGED);
      return device;
    } finally { db.close(); }
  });
}

export function revokeDeviceTrust(): Promise<void> {
  return exclusive(async () => {
    blockDeviceTrust();
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(DEVICE_TRUST_STORE, "readwrite", { durability: "strict" });
        transaction.objectStore(DEVICE_TRUST_STORE).put({ revision: crypto.randomUUID(), device: null }, RECORD_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error(UNAVAILABLE));
      });
    } finally { db.close(); }
  });
}
