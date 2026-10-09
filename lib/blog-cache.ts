import { blogArchiveSchema, type BlogArchive } from "./blog";

const DATABASE = "life-workbench-public-blog";
const STORE = "archive";
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error("博客缓存暂时不可用。"));
    request.onblocked = () => reject(new Error("博客缓存暂时不可用。"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
export async function readBlogCache(): Promise<BlogArchive | null> {
  const db = await database();
  try {
    const value: unknown = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (value === undefined) return null;
    return blogArchiveSchema.parse(value);
  } finally { db.close(); }
}
export async function saveBlogCache(archive: BlogArchive): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore(STORE).put(blogArchiveSchema.parse(archive), "current");
    });
  } finally { db.close(); }
}
export async function clearBlogCache(): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore(STORE).delete("current");
    });
  } finally { db.close(); }
}
