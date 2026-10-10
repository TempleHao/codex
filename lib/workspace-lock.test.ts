import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkspaceLock from "./workspace-lock";

const revision = vi.hoisted(() => ({ value: null as string | null, read: vi.fn(), write: vi.fn() }));
vi.mock("./workspace-revision", async importOriginal => ({
  ...await importOriginal<typeof import("./workspace-revision")>(),
  readWorkspaceRevision: revision.read,
  writeWorkspaceRevision: revision.write,
}));

class FakeStorage implements Storage {
  private entries = new Map<string, string>();
  writes = 0;
  failRead = false;
  failWrite = false;
  failRemove = false;
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  clear() { this.entries.clear(); }
  getItem(key: string) {
    if (this.failRead) throw new DOMException("blocked", "SecurityError");
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw new DOMException("full", "QuotaExceededError");
    this.entries.set(key, value); this.writes += 1;
  }
  removeItem(key: string) {
    if (this.failRemove) throw new DOMException("blocked", "SecurityError");
    this.entries.delete(key);
  }
}

const PASSWORD = "synthetic-password-2026";
const LEGACY = '{ "version":1,"tasks":[],"sources":[],"batches":{},"unknown":{"marker":"synthetic-private-marker-982"},"life":{"finance":{"balance":12345}} }';
let lock: typeof WorkspaceLock;
let storage: FakeStorage;
let fakeWindow: EventTarget & { localStorage: Storage; location: { origin: string } };
let key: string;

beforeEach(async () => {
  vi.resetModules();
  revision.value = null;
  revision.read.mockReset().mockImplementation(async () => revision.value);
  revision.write.mockReset().mockImplementation(async (fingerprint: string) => { revision.value = fingerprint; });
  storage = new FakeStorage();
  fakeWindow = Object.assign(new EventTarget(), { localStorage: storage, location: { origin: "https://example.test" } });
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, operation: () => Promise<unknown>) => operation() } });
  lock = await import("./workspace-lock");
  key = lock.WORKSPACE_STORAGE_KEY;
});

afterEach(() => { lock?.lockWorkspace(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function emitStorage(area: Storage = storage, url = "https://example.test/another-tab"): void {
  const event = new Event("storage");
  Object.assign(event, { key, storageArea: area, url });
  fakeWindow.dispatchEvent(event);
}

async function readPlaintext(): Promise<string | null> {
  return lock.withUnlockedWorkspace(scratch => scratch.getItem(key), { readOnly: true });
}

async function encryptedFixture(): Promise<string> {
  storage.setItem(key, LEGACY);
  await lock.setupWorkspaceLock(PASSWORD);
  return storage.getItem(key)!;
}

describe("本机工作区加密", () => {
  it("SSR reads report unconfigured without accessing browser storage", () => {
    vi.stubGlobal("window", undefined);
    expect(lock.getWorkspaceLockState()).toEqual({ configured: false, unlocked: false });
  });

  it("migrates the exact legacy document, preserving unknown fields and hiding synthetic secrets", async () => {
    const raw = await encryptedFixture();
    expect(key).toBe("life-workbench-preview-v1");
    expect(storage.length).toBe(1);
    expect(raw).not.toContain("synthetic-private-marker-982");
    expect(raw).not.toContain("balance");
    const envelope = JSON.parse(raw);
    expect(envelope).toMatchObject({ format: "life-workbench-encrypted", version: 1, iterations: 310000 });
    expect(atob(envelope.salt).length).toBe(16);
    expect(atob(envelope.iv).length).toBe(12);
    expect(lock.getWorkspaceLockState()).toEqual({ configured: true, unlocked: true });
    expect(await readPlaintext()).toBe(LEGACY);
    lock.lockWorkspace();
    await lock.unlockWorkspace(PASSWORD);
    expect(await readPlaintext()).toBe(LEGACY);
  });

  it("initializes an encrypted empty record and never rewrites ciphertext on reads", async () => {
    await lock.setupWorkspaceLock(PASSWORD);
    const before = storage.getItem(key);
    const writes = storage.writes;
    expect(JSON.parse((await readPlaintext())!)).toEqual({ version: 1, tasks: [], sources: [], batches: {} });
    await readPlaintext();
    expect(storage.getItem(key)).toBe(before);
    expect(storage.writes).toBe(writes);
  });

  it("wrong passwords and modified authenticated ciphertext cannot unlock or write", async () => {
    const before = await encryptedFixture();
    lock.lockWorkspace();
    await expect(lock.unlockWorkspace("wrong-password")).rejects.toThrow("口令不正确或加密记录已损坏");
    expect(storage.getItem(key)).toBe(before);
    expect(lock.getWorkspaceLockState().unlocked).toBe(false);
    const envelope = JSON.parse(before);
    const bytes = Uint8Array.from(atob(envelope.ciphertext), character => character.charCodeAt(0));
    bytes[0] ^= 1;
    envelope.ciphertext = btoa(String.fromCharCode(...bytes));
    const tampered = JSON.stringify(envelope);
    storage.setItem(key, tampered);
    await expect(lock.unlockWorkspace(PASSWORD)).rejects.toThrow("口令不正确或加密记录已损坏");
    expect(storage.getItem(key)).toBe(tampered);
  });

  it.each([
    { format: "tampered-format" }, { version: 2 }, { iterations: 1 }, { salt: "AA==" },
    { iv: "AA==" }, { ciphertext: "bad!" }, { unexpected: "extra" },
  ])("rejects malformed encrypted headers before setup or decryption: %j", async patch => {
    const original = await encryptedFixture();
    lock.lockWorkspace();
    const tampered = JSON.stringify({ ...JSON.parse(original), ...patch });
    storage.setItem(key, tampered);
    expect(lock.getWorkspaceLockState()).toMatchObject({ configured: true, unlocked: false, error: expect.any(String) });
    await expect(lock.setupWorkspaceLock(PASSWORD)).rejects.toThrow("已损坏");
    await expect(lock.unlockWorkspace(PASSWORD)).rejects.toThrow("已损坏");
    expect(storage.getItem(key)).toBe(tampered);
  });

  it("authenticates the IV in the header and treats it like a wrong password", async () => {
    const original = await encryptedFixture();
    lock.lockWorkspace();
    const envelope = JSON.parse(original);
    envelope.iv = btoa(String.fromCharCode(...new Uint8Array(12)));
    const modified = JSON.stringify(envelope);
    storage.setItem(key, modified);
    await expect(lock.unlockWorkspace(PASSWORD)).rejects.toThrow("口令不正确或加密记录已损坏");
    expect(storage.getItem(key)).toBe(modified);
  });

  it("encrypts mutations and clears the scratch store even when retained by a caller", async () => {
    await encryptedFixture();
    let retained: Storage | undefined;
    await lock.withUnlockedWorkspace(scratch => {
      retained = scratch;
      const data = JSON.parse(scratch.getItem(key)!);
      data.unknown.marker = "synthetic-updated-secret";
      scratch.setItem(key, JSON.stringify(data));
    });
    expect(retained!.length).toBe(0);
    expect(storage.getItem(key)).not.toContain("synthetic-updated-secret");
    expect(JSON.parse((await readPlaintext())!).unknown.marker).toBe("synthetic-updated-secret");
    const before = storage.getItem(key);
    await expect(lock.withUnlockedWorkspace(scratch => {
      scratch.setItem(key, "{}"); throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    expect(storage.getItem(key)).toBe(before);
  });

  it("workspace clear saves encrypted empty data while keeping the password", async () => {
    await encryptedFixture();
    await lock.withUnlockedWorkspace(scratch => scratch.removeItem(key));
    expect(lock.getWorkspaceLockState()).toEqual({ configured: true, unlocked: true });
    expect(JSON.parse((await readPlaintext())!)).toEqual({ version: 1, tasks: [], sources: [], batches: {} });
    lock.lockWorkspace();
    await lock.unlockWorkspace(PASSWORD);
    expect(storage.getItem(key)).toContain("life-workbench-encrypted");
  });

  it("serializes concurrent mutations and reads the latest ciphertext for each operation", async () => {
    await lock.setupWorkspaceLock(PASSWORD);
    const increment = () => lock.withUnlockedWorkspace(async scratch => {
      const data = JSON.parse(scratch.getItem(key)!);
      await Promise.resolve();
      data.counter = (data.counter ?? 0) + 1;
      scratch.setItem(key, JSON.stringify(data));
    });
    await Promise.all([increment(), increment(), increment()]);
    expect(JSON.parse((await readPlaintext())!).counter).toBe(3);
  });

  it("locking cancels in-flight and already queued operations without later writes", async () => {
    const before = await encryptedFixture();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const operation = lock.withUnlockedWorkspace(async scratch => {
      started(); await blocked; scratch.setItem(key, "{}");
    });
    const queued = lock.withUnlockedWorkspace(scratch => scratch.setItem(key, "{}"));
    const outcomes = Promise.allSettled([operation, queued]);
    await ready;
    lock.lockWorkspace(); release();
    expect((await outcomes).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(storage.getItem(key)).toBe(before);
    await expect(readPlaintext()).rejects.toThrow("请先解锁");
  });

  it("destructive reset cancels an in-flight save and removes only the workspace key", async () => {
    await encryptedFixture();
    storage.setItem("unrelated-setting", "keep");
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const operation = lock.withUnlockedWorkspace(async scratch => {
      started(); await blocked; scratch.setItem(key, "{}");
    });
    const outcome = Promise.allSettled([operation]);
    await ready;
    lock.resetWorkspaceLock(); release();
    expect((await outcome)[0].status).toBe("rejected");
    expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem("unrelated-setting")).toBe("keep");
    expect(lock.getWorkspaceLockState()).toEqual({ configured: false, unlocked: false });
  });

  it("failed migration, mutation and reset leave the previous record intact", async () => {
    storage.setItem(key, LEGACY);
    storage.failWrite = true;
    await expect(lock.setupWorkspaceLock(PASSWORD)).rejects.toThrow("空间不足");
    expect(storage.getItem(key)).toBe(LEGACY);
    expect(lock.getWorkspaceLockState().unlocked).toBe(false);
    storage.failWrite = false;
    await lock.setupWorkspaceLock(PASSWORD);
    const before = storage.getItem(key);
    storage.failWrite = true;
    await expect(lock.withUnlockedWorkspace(scratch => scratch.setItem(key, "{}"))).rejects.toThrow("空间不足");
    expect(storage.getItem(key)).toBe(before);
    storage.failRemove = true;
    expect(() => lock.resetWorkspaceLock()).toThrow("禁止删除");
    expect(storage.getItem(key)).toBe(before);
    expect(lock.getWorkspaceLockState().unlocked).toBe(true);
  });

  it("rejects an external replacement before committing our mutation", async () => {
    const original = await encryptedFixture();
    const externallyChanged = JSON.stringify({ ...JSON.parse(original), iv: btoa(String.fromCharCode(...new Uint8Array(12))) });
    await expect(lock.withUnlockedWorkspace(scratch => {
      scratch.setItem(key, "{}"); storage.setItem(key, externallyChanged);
    })).rejects.toThrow("已改变");
    expect(storage.getItem(key)).toBe(externallyChanged);
  });

  it("refuses writes without Web Locks while preserving unlock and backup access", async () => {
    const original = await encryptedFixture();
    vi.stubGlobal("navigator", {});
    const operation = vi.fn((scratch: Storage) => scratch.setItem(key, "{}"));
    await expect(lock.withUnlockedWorkspace(operation)).rejects.toThrow("请升级");
    expect(operation).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(original);
    lock.lockWorkspace();
    await lock.unlockWorkspace(PASSWORD);
    expect(await readPlaintext()).toBe(LEGACY);
  });

  it("external reset or salt change locks the session; unrelated origins/storage do not", async () => {
    const original = await encryptedFixture();
    const listener = vi.fn();
    const unsubscribe = lock.subscribeWorkspaceLock(listener);
    emitStorage(new FakeStorage());
    emitStorage(storage, "https://other.test/tab");
    expect(listener).not.toHaveBeenCalled();
    emitStorage();
    expect(listener).toHaveBeenCalledOnce();
    expect(lock.getWorkspaceLockState().unlocked).toBe(true);
    const envelope = JSON.parse(original);
    envelope.salt = btoa(String.fromCharCode(...new Uint8Array(16)));
    storage.setItem(key, JSON.stringify(envelope));
    emitStorage();
    expect(lock.getWorkspaceLockState().unlocked).toBe(false);
    storage.removeItem(key); emitStorage();
    expect(lock.getWorkspaceLockState().configured).toBe(false);
    unsubscribe();
  });

  it("waits for a stale renderer to observe the committed ciphertext before mutating", async () => {
    const oldRaw = await encryptedFixture();
    await lock.withUnlockedWorkspace(scratch => {
      const data = JSON.parse(scratch.getItem(key)!);
      data.counter = 1;
      scratch.setItem(key, JSON.stringify(data));
    });
    const latestRaw = storage.getItem(key)!;
    storage.setItem(key, oldRaw); // Simulate a renderer cache lagging behind the marker.
    const operation = vi.fn((scratch: Storage) => {
      const data = JSON.parse(scratch.getItem(key)!);
      data.counter += 1;
      scratch.setItem(key, JSON.stringify(data));
    });
    const pending = lock.withUnlockedWorkspace(operation);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(operation).not.toHaveBeenCalled();
    storage.setItem(key, latestRaw);
    await pending;
    expect(JSON.parse((await readPlaintext())!).counter).toBe(2);
  });

  it("refuses mismatched versions while allowing read-only backup access", async () => {
    const original = await encryptedFixture();
    revision.value = "0".repeat(64);
    const operation = vi.fn((scratch: Storage) => scratch.setItem(key, "{}"));
    await expect(lock.withUnlockedWorkspace(operation)).rejects.toThrow("保存版本尚未同步");
    expect(operation).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(original);
    expect(await readPlaintext()).toBe(LEGACY);
  });

  it("rolls back ciphertext when committing the revision fails", async () => {
    const original = await encryptedFixture();
    const fingerprint = revision.value;
    revision.write.mockRejectedValueOnce(new Error("synthetic revision failure"));
    await expect(lock.withUnlockedWorkspace(scratch => scratch.setItem(key, "{}"))).rejects.toThrow("synthetic revision failure");
    expect(storage.getItem(key)).toBe(original);
    expect(revision.value).toBe(fingerprint);
    expect(await readPlaintext()).toBe(LEGACY);
  });

  it("refuses writes when the revision store is unavailable but still allows read-only access", async () => {
    const original = await encryptedFixture();
    revision.read.mockRejectedValueOnce(new Error("synthetic revision unavailable"));
    const operation = vi.fn((scratch: Storage) => scratch.setItem(key, "{}"));
    await expect(lock.withUnlockedWorkspace(operation)).rejects.toThrow("synthetic revision unavailable");
    expect(operation).not.toHaveBeenCalled();
    expect(storage.getItem(key)).toBe(original);
    expect(await readPlaintext()).toBe(LEGACY);
  });

  it("restores a legacy record if setup cannot commit its revision", async () => {
    storage.setItem(key, LEGACY);
    revision.write.mockRejectedValueOnce(new Error("synthetic revision failure"));
    await expect(lock.setupWorkspaceLock(PASSWORD)).rejects.toThrow("synthetic revision failure");
    expect(storage.getItem(key)).toBe(LEGACY);
    expect(revision.value).toBeNull();
    expect(lock.getWorkspaceLockState().unlocked).toBe(false);
  });

  it("initializes an older encrypted workspace without a revision and forbids writes from read-only operations", async () => {
    await encryptedFixture();
    revision.value = null;
    await lock.withUnlockedWorkspace(scratch => scratch.getItem(key));
    expect(revision.value).toMatch(/^[0-9a-f]{64}$/);
    const original = storage.getItem(key);
    await expect(lock.withUnlockedWorkspace(scratch => scratch.setItem(key, "{}"), { readOnly: true })).rejects.toThrow("只读操作");
    expect(storage.getItem(key)).toBe(original);
  });

  it("replaces the revision when a reset is followed by a new setup", async () => {
    await encryptedFixture();
    const oldRevision = revision.value;
    lock.resetWorkspaceLock();
    await lock.setupWorkspaceLock(PASSWORD);
    expect(revision.value).not.toBe(oldRevision);
    await lock.withUnlockedWorkspace(scratch => scratch.setItem(key, "{}"));
    expect(await readPlaintext()).toBe("{}");
  });

  it("uses the storage key as an exclusive Web Lock name", async () => {
    const request = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal("navigator", { locks: { request } });
    await lock.setupWorkspaceLock(PASSWORD);
    await readPlaintext();
    expect(request).toHaveBeenCalledWith(key, { mode: "exclusive" }, expect.any(Function));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects short passwords, malformed legacy JSON and unavailable browser storage", async () => {
    await expect(lock.setupWorkspaceLock("short")).rejects.toThrow("8 至 256");
    expect(storage.getItem(key)).toBeNull();
    storage.setItem(key, "[1,2]");
    await expect(lock.setupWorkspaceLock(PASSWORD)).rejects.toThrow("已损坏");
    expect(storage.getItem(key)).toBe("[1,2]");
    storage.failRead = true;
    expect(lock.getWorkspaceLockState()).toMatchObject({ configured: true, unlocked: false, error: expect.stringContaining("禁止读取") });
  });
});
