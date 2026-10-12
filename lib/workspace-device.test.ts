import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockDeviceTrust, deviceTrustAllowed, DEVICE_TRUST_DATABASE, DEVICE_TRUST_POLICY_KEY, DEVICE_TRUST_STORE,
  DEVICE_TRUST_TTL_MS, readDeviceTrust, rememberDevice, revokeDeviceTrust } from "./workspace-device";

/** Transactional IDB fake: writes become visible only after successful completion. */
class TrustDatabase {
  value: unknown;
  failWrite = false;
  beforeGet?: () => void;
  beforeCommit?: () => void;
  open = vi.fn(() => {
    const request = { result: { createObjectStore: vi.fn(), close: vi.fn(), transaction: this.transaction } } as unknown as IDBOpenDBRequest;
    queueMicrotask(() => request.onsuccess?.({} as Event));
    return request;
  });
  transaction = vi.fn((_name: string, mode: string) => {
    let aborted = false;
    let pending = this.value;
    const request = {} as IDBRequest;
    const transaction = {
      abort: () => { aborted = true; },
      objectStore: () => ({
        get: () => request,
        put: (value: unknown) => { pending = structuredClone(value); if (this.failWrite) aborted = true; },
      }),
    } as unknown as IDBTransaction;
    queueMicrotask(() => {
      this.beforeGet?.();
      Object.assign(request, { result: structuredClone(this.value) });
      request.onsuccess?.({} as Event);
      queueMicrotask(() => {
        this.beforeCommit?.();
        if (aborted) transaction.onabort?.({} as Event);
        else {
          if (mode === "readwrite") this.value = pending;
          transaction.oncomplete?.({} as Event);
        }
      });
    });
    return transaction;
  });
}

const SALT = "AAAAAAAAAAAAAAAAAAAAAA==";
let db: TrustDatabase;
let storage: Storage;
let key: CryptoKey;
let requestLock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = new TrustDatabase();
  const entries = new Map<string, string>();
  storage = {
    getItem: vi.fn((name: string) => entries.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { entries.set(name, value); }),
    removeItem: vi.fn((name: string) => { entries.delete(name); }),
    clear: () => entries.clear(), key: () => null, get length() { return entries.size; },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("indexedDB", { open: db.open });
  let queue: Promise<unknown> = Promise.resolve();
  requestLock = vi.fn((_name: string, _options: unknown, operation: () => Promise<unknown>) => {
    const result = queue.then(operation); queue = result.catch(() => undefined); return result;
  });
  vi.stubGlobal("navigator", { locks: { request: requestLock } });
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("device trust", () => {
  it("stores only a nonextractable key and metadata with a fixed absolute 30 day deadline", async () => {
    expect(await readDeviceTrust()).toEqual({ revision: null, device: null });
    const device = await rememberDevice(key, SALT, null, () => true);
    expect(device.expiresAt - device.createdAt).toBe(DEVICE_TRUST_TTL_MS);
    expect(Object.keys(device).sort()).toEqual(["createdAt", "expiresAt", "id", "key", "salt"]);
    const first = await readDeviceTrust();
    expect(first.revision).toBe(device.id);
    expect(first.device?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", first.device!.key)).rejects.toThrow();
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, first.device!.key, new TextEncoder().encode("synthetic"));
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, ciphertext))).toBe("synthetic");
    expect((await readDeviceTrust()).device?.expiresAt).toBe(device.expiresAt);
    expect(db.open).toHaveBeenCalledWith(DEVICE_TRUST_DATABASE, 1);
    expect(db.transaction).toHaveBeenCalledWith(DEVICE_TRUST_STORE, "readwrite", { durability: "strict" });
    expect(requestLock).toHaveBeenCalledWith("life-workbench-device-trust", { mode: "exclusive" }, expect.any(Function));
    expect(storage.length).toBe(1);
  });

  it("rejects expired and future-dated trust without deleting or extending it", async () => {
    const device = await rememberDevice(key, SALT, null, () => true);
    const stored = db.value;
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(device.createdAt - 1);
    expect(deviceTrustAllowed(device)).toBe(false);
    clock.mockReturnValue(device.createdAt);
    expect(deviceTrustAllowed(device)).toBe(true);
    clock.mockReturnValue(device.expiresAt - 1);
    expect(deviceTrustAllowed(device)).toBe(true);
    clock.mockReturnValue(device.expiresAt);
    expect(await readDeviceTrust()).toEqual({ revision: device.id, device: null });
    expect(db.value).toBe(stored);
  });

  it("CAS rejects a stale revision and preserves the newer trust and policy", async () => {
    const device = await rememberDevice(key, SALT, null, () => true);
    await expect(rememberDevice(key, SALT, null, () => true)).rejects.toThrow("已改变");
    expect(storage.getItem(DEVICE_TRUST_POLICY_KEY)).toBe(device.id);
    expect((await readDeviceTrust()).revision).toBe(device.id);
  });

  it("checks authorization before starting and again before writing", async () => {
    await expect(rememberDevice(key, SALT, null, () => false)).rejects.toThrow("已改变");
    expect(db.open).not.toHaveBeenCalled();
    let authorized = true;
    db.beforeGet = () => { authorized = false; };
    await expect(rememberDevice(key, SALT, null, () => authorized)).rejects.toThrow("已改变");
    expect(db.value).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  it("does not re-enable a nonce revoked while the write is completing", async () => {
    db.beforeCommit = () => blockDeviceTrust();
    await expect(rememberDevice(key, SALT, null, () => true)).rejects.toThrow("已改变");
    db.beforeCommit = undefined;
    expect((await readDeviceTrust()).device).toBeNull();
  });

  it("synchronous blocking and failed IDB revocation leave the key unusable", async () => {
    const device = await rememberDevice(key, SALT, null, () => true);
    blockDeviceTrust();
    expect(deviceTrustAllowed(device)).toBe(false);
    db.failWrite = true;
    await expect(revokeDeviceTrust()).rejects.toThrow("无法记住");
    expect((await readDeviceTrust()).device).toBeNull();
    expect((db.value as { device: unknown }).device).not.toBeNull();
    db.failWrite = false;
    await revokeDeviceTrust();
    expect(await readDeviceTrust()).toEqual({ revision: expect.any(String), device: null });
  });

  it("aborted writes and blocked storage never create usable trust", async () => {
    db.failWrite = true;
    await expect(rememberDevice(key, SALT, null, () => true)).rejects.toThrow();
    expect(db.value).toBeUndefined();
    db.failWrite = false;
    vi.mocked(storage.setItem).mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    await expect(rememberDevice(key, SALT, null, () => true)).rejects.toThrow();
    expect(db.value).toBeUndefined();
    expect(() => blockDeviceTrust()).toThrow("无法取消");
  });

  it("invalid keys or stored records never restore or delete trust", async () => {
    const extractable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    await expect(rememberDevice(extractable, SALT, null, () => true)).rejects.toThrow();
    await expect(rememberDevice(key, "bad-salt", null, () => true)).rejects.toThrow();
    const device = await rememberDevice(key, SALT, null, () => true);
    db.value = { revision: device.id, device: { ...device, expiresAt: device.expiresAt + 1 } };
    const stored = db.value;
    expect(await readDeviceTrust()).toEqual({ revision: device.id, device: null });
    expect(db.value).toBe(stored);
    db.value = { revision: 1, device };
    await expect(readDeviceTrust()).rejects.toThrow();
  });

  it("requires Web Locks for mutations and handles absent IndexedDB or policy access", async () => {
    vi.stubGlobal("navigator", {});
    await expect(rememberDevice(key, SALT, null, () => true)).rejects.toThrow();
    await expect(revokeDeviceTrust()).rejects.toThrow();
    vi.stubGlobal("indexedDB", undefined);
    await expect(readDeviceTrust()).rejects.toThrow();
  });
});
