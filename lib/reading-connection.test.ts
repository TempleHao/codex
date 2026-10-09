import { describe, expect, it, vi } from "vitest";
import { createReadingConnection, type ReadingConnectionStore } from "./reading-connection";
import { decryptReadingLibraryWithKey, encryptReadingLibrary, importReadingUnlockKey } from "./reading-envelope";
import { emptyReadingLibrary } from "./reading";
import { createWeReadAutoSync, type WeReadAutoSyncState } from "../components/useWeReadAutoSync";
const PASSWORD = "test-only-reading-long-passphrase";
function storage(initial: unknown = null) {
  let value = initial;
  const store: ReadingConnectionStore = { read: async () => value, write: async key => { value = key; } };
  return { store, value: () => value };
}
describe("local reading auto unlock", () => {
  it("stores reusable non-extractable material and decrypts independently salted snapshots", async () => {
    const key = await importReadingUnlockKey(PASSWORD);
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe("PBKDF2");
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const data = storage();
    const connection = createReadingConnection({ store: data.store });
    await connection.save(structuredClone(key));
    const first = await encryptReadingLibrary(emptyReadingLibrary(), PASSWORD);
    const latest = { ...emptyReadingLibrary(), books: [{ id: "new", title: "最新书架", author: "", kind: "ebook" as const, status: "reading" as const }] };
    const second = await encryptReadingLibrary(latest, PASSWORD);
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(await decryptReadingLibraryWithKey(second, (await connection.read())!)).toEqual(latest);
    expect(JSON.stringify(data.value())).not.toContain(PASSWORD);
    await connection.disconnect();
    expect(await connection.read()).toBeNull();
  });
  it("rejects raw passwords and extractable or AES keys as saved unlock settings", async () => {
    const data = storage(PASSWORD);
    const connection = createReadingConnection({ store: data.store });
    await expect(connection.read()).rejects.toThrow();
    const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["decrypt"]);
    await expect(connection.save(aes)).rejects.toThrow();
    expect(data.value()).toBe(PASSWORD);
  });
  it("deduplicates startup replay, imports on each new root load, and retains data after bad ciphertext", async () => {
    const key = await importReadingUnlockKey(PASSWORD);
    const connection = createReadingConnection({ store: storage(key).store });
    const library = emptyReadingLibrary();
    let envelope = await encryptReadingLibrary(library, PASSWORD);
    const fetchResource = vi.fn(async (name: string, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(name.includes("status") ? { version: 1, state: "ready", updatedAt: "2026-10-09T00:00:00Z" } : envelope));
    });
    const onImport = vi.fn(async () => {});
    let state!: WeReadAutoSyncState;
    const options = { connection, fetchResource, onImport, onState: (next: WeReadAutoSyncState) => { state = next; } };
    const first = createWeReadAutoSync(options);
    await Promise.all([first.start(), first.start(), first.start()]);
    expect(fetchResource).toHaveBeenCalledTimes(2);
    expect(onImport).toHaveBeenCalledExactlyOnceWith(library);
    await createWeReadAutoSync(options).start();
    expect(fetchResource).toHaveBeenCalledTimes(4);
    expect(onImport).toHaveBeenCalledTimes(2);
    envelope = { ...envelope, ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}` };
    await first.refresh();
    expect(onImport).toHaveBeenCalledTimes(2);
    expect(state.error).toContain("现有阅读记录未更改");
    await first.disconnect();
    expect(await connection.read()).toBeNull();
    expect(onImport).toHaveBeenCalledTimes(2);
  });
  it("checks both resources without importing when first-time visitors have no unlock key", async () => {
    const connection = createReadingConnection({ store: storage().store });
    const envelope = await encryptReadingLibrary(emptyReadingLibrary(), PASSWORD);
    const onImport = vi.fn(async () => {});
    const fetchResource = vi.fn(async (name: string) => new Response(JSON.stringify(name.includes("status") ? { version: 1, state: "ready", updatedAt: "2026-10-09T00:00:00Z" } : envelope)));
    const controller = createWeReadAutoSync({ connection, fetchResource, onImport, onState: () => {} });
    await controller.start();
    expect(fetchResource).toHaveBeenCalledTimes(2);
    expect(onImport).not.toHaveBeenCalled();
    expect(await connection.read()).toBeNull();
  });
  it("reports a failed key deletion to callers instead of claiming automatic unlock is disabled", async () => {
    const key = await importReadingUnlockKey(PASSWORD);
    const data = storage(key);
    data.store.write = async () => { throw new Error("StorageUnavailable"); };
    const connection = createReadingConnection({ store: data.store });
    let state!: WeReadAutoSyncState;
    const controller = createWeReadAutoSync({ connection, onImport: async () => {}, onState: next => { state = next; } });
    await expect(controller.disconnect()).rejects.toThrow("关闭自动解锁未完成");
    expect(state.error).toContain("关闭自动解锁未完成");
    expect(await connection.read()).toBe(key);
  });
});
