/** A committed ciphertext fingerprint, never workspace contents or key material. */
export const WORKSPACE_REVISION_DATABASE = "life-workbench-workspace-revision-v1";
export const WORKSPACE_REVISION_STORE = "revisions";
const REVISION_KEY = "life-workbench-preview-v1";
const UNAVAILABLE = "浏览器无法确认本机记录的保存版本，未继续保存。请刷新后重试，或先导出备份。";

export async function workspaceFingerprint(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error(UNAVAILABLE);
  return new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(WORKSPACE_REVISION_DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WORKSPACE_REVISION_STORE);
    request.onsuccess = () => {
      if (rejected) request.result.close();
      else resolve(request.result);
    };
    request.onerror = request.onblocked = () => { rejected = true; reject(new Error(UNAVAILABLE)); };
  });
}

export async function readWorkspaceRevision(): Promise<string | null> {
  const db = await database();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const transaction = db.transaction(WORKSPACE_REVISION_STORE, "readonly");
      const request = transaction.objectStore(WORKSPACE_REVISION_STORE).get(REVISION_KEY);
      transaction.oncomplete = () => {
        const value: unknown = request.result;
        if (value === undefined) resolve(null);
        else if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) resolve(value);
        else reject(new Error(UNAVAILABLE));
      };
      transaction.onabort = () => reject(new Error(UNAVAILABLE));
    });
  } catch { throw new Error(UNAVAILABLE); }
  finally { db.close(); }
}

export async function writeWorkspaceRevision(fingerprint: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(WORKSPACE_REVISION_STORE, "readwrite", { durability: "strict" });
      transaction.objectStore(WORKSPACE_REVISION_STORE).put(fingerprint, REVISION_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error(UNAVAILABLE));
    });
  } catch { throw new Error(UNAVAILABLE); }
  finally { db.close(); }
}
