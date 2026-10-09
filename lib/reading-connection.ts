// Unlock material stays separate from workspace state, backups and web storage.
const DATABASE = "life-workbench-reading-connection-v1";
const STORE = "connection";
export interface ReadingConnectionStore {
  read(): Promise<unknown>;
  write(key: CryptoKey | null): Promise<void>;
}
function validKey(value: unknown): value is CryptoKey {
  // CryptoKeys read from IndexedDB may come from another realm.
  const key = value as CryptoKey | null;
  return !!key && key.type === "secret" && key.extractable === false
    && key.algorithm?.name === "PBKDF2" && key.usages?.length === 1 && key.usages[0] === "deriveKey";
}
function browserStore(): ReadingConnectionStore {
  async function database(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") throw new Error("ReadingStorageUnavailable");
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = request.onblocked = () => reject(new Error("ReadingStorageUnavailable"));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  async function transaction(write: boolean, key?: CryptoKey | null): Promise<unknown> {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, write ? "readwrite" : "readonly");
        const store = tx.objectStore(STORE);
        const request = write ? (key ? store.put(key, "active") : store.delete("active")) : store.get("active");
        tx.oncomplete = () => resolve(write ? undefined : request.result ?? null);
        tx.onerror = tx.onabort = () => reject(new Error("ReadingStorageUnavailable"));
      });
    } finally { db.close(); }
  }
  return { read: () => transaction(false), write: async key => { await transaction(true, key); } };
}
export function createReadingConnection(dependencies: { store?: ReadingConnectionStore } = {}) {
  const store = dependencies.store ?? browserStore();
  let generation = 0;
  let tail = Promise.resolve();
  function write(key: CryptoKey | null) {
    const operation = tail.then(() => store.write(key));
    tail = operation.catch(() => {});
    return operation;
  }
  async function read(): Promise<CryptoKey | null> {
    const value = await store.read();
    if (value == null) return null;
    if (!validKey(value)) throw new Error("ReadingUnlockKeyInvalid");
    return value;
  }
  async function save(key: CryptoKey) {
    if (!validKey(key)) throw new Error("ReadingUnlockKeyInvalid");
    ++generation;
    await write(key);
  }
  async function disconnect() { ++generation; await write(null); }
  return { read, save, disconnect, revision: () => generation };
}
export const readingConnection = createReadingConnection();
