import { createCipheriv, createDecipheriv, pbkdf2Sync, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyReadingLibrary, type ReadingLibrary } from "./reading";
import {
  decryptReadingLibrary, encryptReadingLibrary, generateReadingPassphrase,
  MAX_READING_ENVELOPE_BYTES, readingEnvelopeSchema, type ReadingEnvelope,
} from "./reading-envelope";

const PASSPHRASE = "test-only-random-sync-passphrase-例子";
const AAD = Buffer.from("life-reading-encrypted:1", "utf8");
const sampleLibrary = (): ReadingLibrary => ({
  ...emptyReadingLibrary(),
  source: "weread",
  syncedAt: "2026-10-08T08:00:00.000Z",
  books: [{ id: "book-example", title: "平凡的世界", author: "路遥", kind: "ebook", status: "reading", progress: 18 }],
  highlights: [{ id: "note-example", bookId: "book-example", text: "生活不能等待别人来安排。\n第二行，保留原文。", thought: "我注意到了什么？\n慢慢想。" }],
  stats: { totalSeconds: 3_660, dailySeconds: [{ date: "2026-10-08", seconds: 3_660 }], mode: "overall", period: null },
});

/** Independent Node OpenSSL implementation of the published wire format. */
function nodeEnvelope(plaintext: string, iterations = 100_000): ReadingEnvelope {
  const salt = Buffer.from("0123456789abcdef");
  const iv = Buffer.from("example-iv12");
  const key = pbkdf2Sync(PASSPHRASE, salt, iterations, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    format: "life-reading-encrypted", version: 1,
    kdf: { name: "PBKDF2-SHA256", iterations, salt: salt.toString("base64url") },
    cipher: { name: "AES-256-GCM", iv: iv.toString("base64url") },
    ciphertext: encrypted.toString("base64url"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("portable authenticated reading encryption", () => {
  it("round-trips Chinese, line breaks, reading dates and statistics", async () => {
    const library = sampleLibrary();
    const envelope = await encryptReadingLibrary(library, PASSPHRASE);
    expect(readingEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.kdf.iterations).toBe(600_000);
    expect(Buffer.from(envelope.kdf.salt, "base64url")).toHaveLength(16);
    expect(Buffer.from(envelope.cipher.iv, "base64url")).toHaveLength(12);
    expect(await decryptReadingLibrary(JSON.stringify(envelope), PASSPHRASE)).toEqual(library);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(library.books[0].title);
    expect(serialized).not.toContain(library.highlights[0].text);
    expect(serialized).not.toContain(PASSPHRASE);
  });

  it("Node WebCrypto output decrypts with an independent Node AES-GCM implementation", async () => {
    const library = sampleLibrary();
    const envelope = await encryptReadingLibrary(library, PASSPHRASE);
    const key = pbkdf2Sync(PASSPHRASE, Buffer.from(envelope.kdf.salt, "base64url"), envelope.kdf.iterations, 32, "sha256");
    const encrypted = Buffer.from(envelope.ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual(library);
  });

  it("browser-standard WebCrypto decrypts an independent Node-encrypted envelope", async () => {
    // The production module only uses the browser WebCrypto, atob, btoa and UTF-8 APIs.
    vi.stubGlobal("crypto", webcrypto);
    const library = sampleLibrary();
    const envelope = nodeEnvelope(JSON.stringify(library));
    expect(await decryptReadingLibrary(envelope, PASSPHRASE)).toEqual(library);
  });

  it("uses fresh salts and nonces so repeated exports do not reveal identical plaintext", async () => {
    const first = await encryptReadingLibrary(sampleLibrary(), PASSPHRASE);
    const second = await encryptReadingLibrary(sampleLibrary(), PASSPHRASE);
    expect(second.kdf.salt).not.toBe(first.kdf.salt);
    expect(second.cipher.iv).not.toBe(first.cipher.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(await decryptReadingLibrary(second, PASSPHRASE)).toEqual(sampleLibrary());
  });

  it("rejects a wrong password and authenticated ciphertext or nonce tampering identically", async () => {
    const envelope = nodeEnvelope(JSON.stringify(sampleLibrary()));
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}` };
    const nonceTampered = { ...envelope, cipher: { ...envelope.cipher, iv: "AAAAAAAAAAAAAAAA" } };
    await expect(decryptReadingLibrary(envelope, "another-wrong-example-password")).rejects.toThrow("无法解密阅读资料，请检查同步口令与文件。");
    await expect(decryptReadingLibrary(tampered, PASSPHRASE)).rejects.toThrow("无法解密阅读资料，请检查同步口令与文件。");
    await expect(decryptReadingLibrary(nonceTampered, PASSPHRASE)).rejects.toThrow("无法解密阅读资料，请检查同步口令与文件。");
  });

  it.each([0, 99_999, 1_000_001, Number.MAX_SAFE_INTEGER, 100_000.5, Infinity])("rejects unsafe KDF iterations %s before doing cryptographic work", async iterations => {
    const envelope = nodeEnvelope(JSON.stringify(emptyReadingLibrary()));
    const derive = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    await expect(decryptReadingLibrary({ ...envelope, kdf: { ...envelope.kdf, iterations } }, PASSPHRASE)).rejects.toThrow("无法解密阅读资料");
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  it("rejects altered metadata and unknown credential fields", async () => {
    const envelope = nodeEnvelope(JSON.stringify(sampleLibrary()));
    const badValues = [
      { ...envelope, format: "other-encrypted-format" },
      { ...envelope, version: 2 },
      { ...envelope, kdf: { ...envelope.kdf, name: "unrecognized-kdf" } },
      { ...envelope, cipher: { ...envelope.cipher, name: "AES-128-CBC" } },
      { ...envelope, apiKey: "test-only-private-credential" },
      { ...envelope, kdf: { ...envelope.kdf, password: PASSPHRASE } },
    ];
    for (const value of badValues) {
      expect(readingEnvelopeSchema.safeParse(value).success).toBe(false);
      await expect(decryptReadingLibrary(value, PASSPHRASE)).rejects.toThrow("无法解密阅读资料，请检查同步口令与文件。");
    }
  });

  it("accepts only canonical base64url encodings and exact salt/nonce lengths", () => {
    const envelope = nodeEnvelope(JSON.stringify(sampleLibrary()));
    const values = [
      { ...envelope, kdf: { ...envelope.kdf, salt: `${envelope.kdf.salt}==` } },
      { ...envelope, kdf: { ...envelope.kdf, salt: "A".repeat(22).slice(0, -1) + "B" } },
      { ...envelope, kdf: { ...envelope.kdf, salt: "A".repeat(20) } },
      { ...envelope, cipher: { ...envelope.cipher, iv: "A".repeat(15) } },
      { ...envelope, cipher: { ...envelope.cipher, iv: "+++++++++++++++=" } },
      { ...envelope, ciphertext: "A".repeat(22).slice(0, -1) + "B" },
      { ...envelope, ciphertext: "A".repeat(21) },
      { ...envelope, ciphertext: "A".repeat(20) },
      { ...envelope, ciphertext: `${envelope.ciphertext}\n` },
    ];
    values.forEach(value => expect(readingEnvelopeSchema.safeParse(value).success).toBe(false));
  });

  it("rejects invalid or secret-bearing reading plaintext at both encryption boundaries", async () => {
    const marker = "test-only-private-credential";
    const invalid = { ...sampleLibrary(), apiKey: marker };
    await expect(encryptReadingLibrary(invalid as ReadingLibrary, PASSPHRASE)).rejects.toThrow("无法加密阅读资料，请检查资料格式与同步口令。");
    await expect(encryptReadingLibrary({ ...sampleLibrary(), highlights: [{ id: "orphan", bookId: "missing", text: marker }] }, PASSPHRASE)).rejects.not.toThrow(marker);
    await expect(decryptReadingLibrary(nodeEnvelope(JSON.stringify(invalid)), PASSPHRASE)).rejects.toThrow("无法解密阅读资料，请检查同步口令与文件。");
    await expect(decryptReadingLibrary(nodeEnvelope(`not JSON ${marker}`), PASSPHRASE)).rejects.not.toThrow(marker);
  });

  it("checks the complete encrypted JSON size, including metadata and UTF-8 bytes", async () => {
    const envelope = nodeEnvelope(JSON.stringify(emptyReadingLibrary()));
    const oversized = { ...envelope, ciphertext: "A".repeat(MAX_READING_ENVELOPE_BYTES) };
    expect(readingEnvelopeSchema.safeParse(oversized).success).toBe(false);
    const derive = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    await expect(decryptReadingLibrary(oversized, PASSPHRASE)).rejects.toThrow("无法解密阅读资料");
    await expect(decryptReadingLibrary(" ".repeat(MAX_READING_ENVELOPE_BYTES + 1), PASSPHRASE)).rejects.toThrow("无法解密阅读资料");
    await expect(decryptReadingLibrary("读".repeat(Math.ceil(MAX_READING_ENVELOPE_BYTES / 3)), PASSPHRASE)).rejects.toThrow("无法解密阅读资料");
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  it("rejects oversized valid reading data before expensive encryption", async () => {
    const library: ReadingLibrary = {
      ...sampleLibrary(),
      highlights: Array.from({ length: 760 }, (_, index) => ({ id: `large-note-${index}`, bookId: "book-example", text: "x".repeat(20_000) })),
    };
    const derive = vi.spyOn(globalThis.crypto.subtle, "deriveKey");
    await expect(encryptReadingLibrary(library, PASSPHRASE)).rejects.toThrow("无法加密阅读资料");
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  it("generates independent 256-bit passwords without retaining them in the envelope", async () => {
    const first = generateReadingPassphrase();
    const second = generateReadingPassphrase();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(second).not.toBe(first);
    const envelope = await encryptReadingLibrary(emptyReadingLibrary(), first);
    expect(JSON.stringify(envelope)).not.toContain(first);
    expect(await decryptReadingLibrary(envelope, first)).toEqual(emptyReadingLibrary());
  });

  it.each(["short", "x".repeat(1_025)])("rejects passwords outside the supported length without reflecting them", async password => {
    await expect(encryptReadingLibrary(emptyReadingLibrary(), password)).rejects.toThrow("无法加密阅读资料，请检查资料格式与同步口令。");
    await expect(decryptReadingLibrary({}, password)).rejects.toThrow("无法解密阅读资料，请检查同步口令与文件。");
  });

  it("accepts supported password boundaries without trimming or normalizing passwords", async () => {
    for (const password of ["x".repeat(16), ` ${"x".repeat(1_022)} `]) {
      const envelope = await encryptReadingLibrary(emptyReadingLibrary(), password);
      expect(await decryptReadingLibrary(envelope, password)).toEqual(emptyReadingLibrary());
    }
  });
});
