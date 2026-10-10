import { test as base, expect, type Page } from "@playwright/test";
import { emptyLifeData, lifeDataSchema, type LifeData } from "../lib/life";
import { WORKSPACE_REVISION_DATABASE, WORKSPACE_REVISION_STORE } from "../lib/workspace-revision";
import { webcrypto } from "node:crypto";
import type { WorkspaceData } from "../lib/types";

export const PREVIEW_TEST_PASSWORD = "preview-test-password-2026";
const STORAGE_KEY = "life-workbench-preview-v1";
export type PreviewWorkspace = WorkspaceData & { version: 1; life: LifeData; batches: Record<string, unknown> };
const watchedPages = new WeakSet<Page>();

/** Exercise the public Gate UI after every document navigation, including new tabs. */
export function watchPreviewUnlock(page: Page) {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  page.on("domcontentloaded", () => {
    // OAuth provider pages are not application workspaces.
    if (!new URL(page.url()).pathname.startsWith("/codex")) return;
    void unlockPreviewWorkspace(page).catch(() => {
      // A navigation may destroy this document; normal app-ready assertions expose
      // any persistent unlock failure in the test that caused it.
    });
  });
}
export async function unlockPreviewWorkspace(page: Page) {
  const gate = page.locator(".workspace-gate");
  await expect(page.locator(".workspace-gate, .workspace").first()).toBeVisible({ timeout: 15000 });
  if (!await gate.isVisible()) return;
  await gate.getByLabel("本机口令", { exact: true }).fill(PREVIEW_TEST_PASSWORD);
  const confirmation = gate.getByLabel("再次输入口令", { exact: true });
  if (await confirmation.isVisible()) {
    await confirmation.fill(PREVIEW_TEST_PASSWORD);
    await gate.getByRole("button", { name: "设置口令并打开", exact: true }).click();
  } else await gate.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.locator(".workspace")).toBeVisible();
}

export const test = base.extend<{ previewUnlock: void }>({
  previewUnlock: [async ({ page, context }, use) => {
    watchPreviewUnlock(page);
    context.on("page", watchPreviewUnlock);
    await use();
    context.off("page", watchPreviewUnlock);
  }, { auto: true }],
});

// Test runner helpers use the actual persisted format; no browser plaintext hook.
interface PreviewEnvelope {
  format: "life-workbench-encrypted"; version: 1; iterations: 310000;
  salt: string; iv: string; ciphertext: string;
}
function aad(envelope: PreviewEnvelope) {
  return new TextEncoder().encode(JSON.stringify({ format: envelope.format, version: envelope.version, iterations: envelope.iterations, salt: envelope.salt, iv: envelope.iv }));
}
const keyCache = new Map<string, ReturnType<typeof webcrypto.subtle.deriveKey>>();
function envelopeKey(envelope: PreviewEnvelope) {
  let key = keyCache.get(envelope.salt);
  if (!key) {
    key = (async () => {
      const material = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(PREVIEW_TEST_PASSWORD), "PBKDF2", false, ["deriveKey"]);
      return webcrypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(Buffer.from(envelope.salt, "base64")), iterations: envelope.iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    keyCache.set(envelope.salt, key);
  }
  return key;
}
export async function decodePreviewWorkspace<T = PreviewWorkspace>(raw: string): Promise<T> {
  const envelope = JSON.parse(raw) as PreviewEnvelope;
  expect(envelope).toMatchObject({ format: "life-workbench-encrypted", version: 1, iterations: 310000 });
  const plain = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(Buffer.from(envelope.iv, "base64")), additionalData: aad(envelope), tagLength: 128 }, await envelopeKey(envelope), Uint8Array.from(Buffer.from(envelope.ciphertext, "base64")));
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  return { ...value, life: lifeDataSchema.parse(value.life ?? emptyLifeData()) } as T;
}
export async function readPreviewWorkspace<T = PreviewWorkspace>(page: Page): Promise<T | null> {
  const raw = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  return raw === null ? null : decodePreviewWorkspace<T>(raw);
}
export async function writePreviewWorkspace(page: Page, value: unknown) {
  const previous = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  const oldEnvelope = previous ? JSON.parse(previous) as PreviewEnvelope : null;
  const envelope: PreviewEnvelope = { format: "life-workbench-encrypted", version: 1, iterations: 310000,
    salt: oldEnvelope?.salt ?? Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64"),
    iv: Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString("base64"), ciphertext: "" };
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: Uint8Array.from(Buffer.from(envelope.iv, "base64")), additionalData: aad(envelope), tagLength: 128 }, await envelopeKey(envelope), new TextEncoder().encode(JSON.stringify(value)));
  envelope.ciphertext = Buffer.from(encrypted).toString("base64");
  const raw = JSON.stringify(envelope);
  const fingerprint = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))).toString("hex");
  // This helper deliberately replaces test data, so update the same committed
  // marker used by application saves while holding the application's Web Lock.
  await page.evaluate(async ({ key, raw, fingerprint, database, store }) => {
    await navigator.locks.request(key, { mode: "exclusive" }, async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        localStorage.setItem(key, raw);
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(store, "readwrite", { durability: "strict" });
          transaction.objectStore(store).put(fingerprint, key);
          transaction.oncomplete = () => resolve();
          transaction.onabort = transaction.onerror = () => reject(transaction.error);
        });
      } finally { db.close(); }
    });
  }, { key: STORAGE_KEY, raw, fingerprint, database: WORKSPACE_REVISION_DATABASE, store: WORKSPACE_REVISION_STORE });
}
