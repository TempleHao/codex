/** Local workspace encryption. Only ciphertext is persistent; the session key is memory-only. */
export const WORKSPACE_STORAGE_KEY = "life-workbench-preview-v1";
const FORMAT = "life-workbench-encrypted";
const ITERATIONS = 310_000;
const MAX_PLAINTEXT_BYTES = 20_000_000;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 16;
const MAX_RAW_CHARACTERS = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4 + 1_024;
const EMPTY_WORKSPACE = JSON.stringify({ version: 1, tasks: [], sources: [], batches: {} });
const CORRUPT = "本机加密记录已损坏或格式不兼容，未修改原数据。";
const UNLOCK_FAILED = "口令不正确或加密记录已损坏，未修改原数据。";
const LOCKED = "请先解锁本机记录。";
const CHANGED = "本机记录或锁定状态已改变，请重新解锁后重试。";

type Envelope = { format: typeof FORMAT; version: 1; iterations: number; salt: string; iv: string; ciphertext: string };
type RecordState = { kind: "empty" | "legacy"; raw: string | null } | { kind: "encrypted"; raw: string; envelope: Envelope };
type Session = { key: CryptoKey; salt: string };
let session: Session | null = null;
let epoch = 0;
let lastError: string | undefined;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
let eventTarget: Window | undefined;

function notify(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* A subscriber cannot change an atomic save's outcome. */ }
  }
}

function forgetSession(): void { session = null; epoch += 1; }

function browserStorage(): Storage {
  try {
    if (typeof window === "undefined") throw new Error();
    return window.localStorage;
  } catch { throw new Error("浏览器禁止读取本机记录，请允许此网站使用本地存储后重试。"); }
}

function readRaw(storage: Storage): string | null {
  try { return storage.getItem(WORKSPACE_STORAGE_KEY); }
  catch { throw new Error("浏览器禁止读取本机记录，请允许此网站使用本地存储后重试。"); }
}

function writeRaw(storage: Storage, raw: string): void {
  try { storage.setItem(WORKSPACE_STORAGE_KEY, raw); }
  catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("浏览器本地存储空间不足，未保存本次内容，原数据仍保留。");
    }
    throw new Error("浏览器禁止保存本机记录，未保存本次内容，原数据仍保留。");
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function decode(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(CORRUPT);
  const binary = atob(value);
  if (binary.length < min || binary.length > max) throw new Error(CORRUPT);
  const result = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(result) !== value) throw new Error(CORRUPT);
  return result;
}

function parseObject(raw: string): Record<string, unknown> {
  if (raw.length > MAX_RAW_CHARACTERS) throw new Error(CORRUPT);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(CORRUPT); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(CORRUPT);
  return value as Record<string, unknown>;
}

function inspect(raw: string | null): RecordState {
  if (raw === null) return { kind: "empty", raw };
  const value = parseObject(raw);
  const encryptedFields = ["format", "salt", "iv", "ciphertext", "iterations"];
  if (!encryptedFields.some(field => Object.hasOwn(value, field))) return { kind: "legacy", raw };
  if (Object.keys(value).sort().join(",") !== "ciphertext,format,iterations,iv,salt,version" ||
      value.format !== FORMAT || value.version !== 1 || value.iterations !== ITERATIONS) throw new Error(CORRUPT);
  decode(value.salt, 16, 16);
  decode(value.iv, 12, 12);
  decode(value.ciphertext, 17, MAX_CIPHERTEXT_BYTES);
  return { kind: "encrypted", raw, envelope: value as Envelope };
}

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error("此浏览器不支持安全加密，请在 HTTPS 网站使用较新的浏览器。");
  return globalThis.crypto;
}

function checkPassword(password: string): void {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw new Error("口令需为 8 至 256 个字符。");
  }
}

function aad(envelope: Omit<Envelope, "ciphertext">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({
    format: envelope.format, version: envelope.version, iterations: envelope.iterations,
    salt: envelope.salt, iv: envelope.iv,
  }));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const provider = requireCrypto();
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const material = await provider.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]);
    return await provider.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { passwordBytes.fill(0); }
}

async function encrypt(plaintext: string, key: CryptoKey, salt: string): Promise<string> {
  parseObject(plaintext);
  const bytes = new TextEncoder().encode(plaintext);
  try {
    if (bytes.length > MAX_PLAINTEXT_BYTES) throw new Error("本机记录过大，未保存本次内容。");
    const provider = requireCrypto();
    const iv = provider.getRandomValues(new Uint8Array(12));
    const header = { format: FORMAT, version: 1, iterations: ITERATIONS, salt, iv: encode(iv) } as const;
    const encrypted = await provider.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(header), tagLength: 128 }, key, bytes);
    return JSON.stringify({ ...header, ciphertext: encode(new Uint8Array(encrypted)) });
  } finally { bytes.fill(0); }
}

async function decrypt(envelope: Envelope, key: CryptoKey): Promise<string> {
  let bytes: Uint8Array | undefined;
  try {
    const result = await requireCrypto().subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv, 12, 12),
      additionalData: aad(envelope), tagLength: 128 }, key, decode(envelope.ciphertext, 17, MAX_CIPHERTEXT_BYTES));
    bytes = new Uint8Array(result);
    if (bytes.length > MAX_PLAINTEXT_BYTES) throw new Error();
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parseObject(raw);
    return raw;
  } catch { throw new Error(UNLOCK_FAILED); }
  finally { bytes?.fill(0); }
}

function ensureEvents(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function" || eventTarget === window) return;
  eventTarget = window;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== null && event.key !== WORKSPACE_STORAGE_KEY) return;
    try {
      if (event.storageArea !== browserStorage()) return;
      if (event.url && new URL(event.url).origin !== window.location.origin) return;
      const record = inspect(readRaw(browserStorage()));
      if (record.kind !== "encrypted" || record.envelope.salt !== session?.salt) forgetSession();
      lastError = undefined;
    } catch (error) { forgetSession(); lastError = error instanceof Error ? error.message : CORRUPT; }
    notify();
  });
}

export function getWorkspaceLockState(): { configured: boolean; unlocked: boolean; error?: string } {
  if (typeof window === "undefined") return { configured: false, unlocked: false };
  ensureEvents();
  try {
    const record = inspect(readRaw(browserStorage()));
    if (session && (record.kind !== "encrypted" || record.envelope.salt !== session.salt)) forgetSession();
    return { configured: record.kind === "encrypted", unlocked: session !== null, ...(lastError ? { error: lastError } : {}) };
  } catch (error) {
    forgetSession();
    return { configured: true, unlocked: false, error: error instanceof Error ? error.message : CORRUPT };
  }
}

export function subscribeWorkspaceLock(listener: () => void): () => void {
  ensureEvents(); listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(WORKSPACE_STORAGE_KEY, { mode: "exclusive" }, operation);
  }
  return operation();
}

function assertEpoch(expected: number): void { if (epoch !== expected) throw new Error(CHANGED); }
function assertUnchanged(storage: Storage, before: string | null, expected: number): void {
  assertEpoch(expected);
  if (readRaw(storage) !== before) throw new Error(CHANGED);
}

export function setupWorkspaceLock(password: string): Promise<void> {
  const expected = epoch;
  return serialized(() => exclusive(async () => {
    assertEpoch(expected);
    checkPassword(password);
    const storage = browserStorage();
    const record = inspect(readRaw(storage));
    if (record.kind === "encrypted") throw new Error("本机记录已设置口令，请使用口令解锁。");
    const salt = requireCrypto().getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    const encodedSalt = encode(salt);
    const encrypted = await encrypt(record.raw ?? EMPTY_WORKSPACE, key, encodedSalt);
    assertUnchanged(storage, record.raw, expected);
    writeRaw(storage, encrypted);
    session = { key, salt: encodedSalt };
    lastError = undefined;
    notify();
  }));
}

export function unlockWorkspace(password: string): Promise<void> {
  const expected = epoch;
  return serialized(() => exclusive(async () => {
    assertEpoch(expected);
    checkPassword(password);
    const storage = browserStorage();
    const record = inspect(readRaw(storage));
    if (record.kind !== "encrypted") throw new Error("请先为本机记录设置口令。");
    // Lock before a new unlock attempt, including when authentication fails.
    session = null;
    const key = await deriveKey(password, decode(record.envelope.salt, 16, 16));
    await decrypt(record.envelope, key);
    assertUnchanged(storage, record.raw, expected);
    session = { key, salt: record.envelope.salt };
    lastError = undefined;
    notify();
  })).catch(error => { notify(); throw error; });
}

export function lockWorkspace(): void { forgetSession(); lastError = undefined; notify(); }

/** Caller must obtain explicit destructive-reset confirmation in the UI first. */
export function resetWorkspaceLock(): void {
  const storage = browserStorage();
  try { storage.removeItem(WORKSPACE_STORAGE_KEY); }
  catch { throw new Error("浏览器禁止删除本机记录，原数据仍保留。"); }
  forgetSession(); lastError = undefined; notify();
}

class ScratchStorage implements Storage {
  private entries = new Map<string, string>();
  constructor(raw: string) { this.entries.set(WORKSPACE_STORAGE_KEY, raw); }
  get length(): number { return this.entries.size; }
  key(index: number): string | null { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.entries.get(String(key)) ?? null; }
  setItem(key: string, value: string): void { this.entries.set(String(key), String(value)); }
  removeItem(key: string): void { this.entries.delete(String(key)); }
  clear(): void { this.entries.clear(); }
}

export function withUnlockedWorkspace<T>(operation: (storage: Storage) => T | Promise<T>): Promise<T> {
  const expected = epoch;
  const active = session;
  return serialized(() => exclusive(async () => {
    assertEpoch(expected);
    const storage = browserStorage();
    const raw = readRaw(storage);
    if (!active || session !== active) throw new Error(LOCKED);
    const record = inspect(raw);
    if (record.kind !== "encrypted" || record.envelope.salt !== active.salt) {
      forgetSession(); notify(); throw new Error(CHANGED);
    }
    let plaintext = await decrypt(record.envelope, active.key);
    let scratch: ScratchStorage | undefined;
    try {
      assertEpoch(expected);
      scratch = new ScratchStorage(plaintext);
      const result = await operation(scratch);
      assertEpoch(expected);
      const next = scratch.getItem(WORKSPACE_STORAGE_KEY) ?? EMPTY_WORKSPACE;
      if (next !== plaintext) {
        const encrypted = await encrypt(next, active.key, active.salt);
        assertUnchanged(storage, record.raw, expected);
        writeRaw(storage, encrypted);
      } else { assertUnchanged(storage, record.raw, expected); }
      return result;
    } finally { scratch?.clear(); plaintext = ""; }
  }));
}
