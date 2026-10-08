import { z } from "zod";
import { readingLibrarySchema, type ReadingLibrary } from "./reading";

/** This is the maximum complete encrypted JSON file size, measured as UTF-8. */
export const MAX_READING_ENVELOPE_BYTES = 20_000_000;

const FORMAT = "life-reading-encrypted";
const VERSION = 1;
const ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 1_000_000;
const AUTH_TAG_BYTES = 16;
const encoder = new TextEncoder();
const associatedData = encoder.encode(`${FORMAT}:${VERSION}`);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Reject padding, alternate encodings, and nonzero unused bits before decoding. */
function canonicalBase64url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  const last = alphabet.indexOf(value.at(-1)!);
  return remainder === 0 || (remainder === 2 ? (last & 15) === 0 : (last & 3) === 0);
}

function decodedLength(value: string): number {
  return Math.floor(value.length * 3 / 4);
}

function fixedBase64url(bytes: number) {
  return z.string().length(Math.ceil(bytes * 4 / 3)).refine(value =>
    canonicalBase64url(value) && decodedLength(value) === bytes,
  "加密文件格式不正确。");
}

export const readingEnvelopeSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(VERSION),
  kdf: z.object({
    name: z.literal("PBKDF2-SHA256"),
    iterations: z.number().int().min(MIN_ITERATIONS).max(MAX_ITERATIONS),
    salt: fixedBase64url(16),
  }).strict(),
  cipher: z.object({
    name: z.literal("AES-256-GCM"),
    iv: fixedBase64url(12),
  }).strict(),
  ciphertext: z.string().min(Math.ceil(AUTH_TAG_BYTES * 4 / 3)).max(MAX_READING_ENVELOPE_BYTES)
    .refine(value => canonicalBase64url(value)
      && decodedLength(value) >= AUTH_TAG_BYTES
      && decodedLength(value) <= MAX_READING_ENVELOPE_BYTES,
    "加密文件格式不正确。"),
}).strict().superRefine((value, context) => {
  // All permitted fields are ASCII; this also includes the JSON field overhead.
  if (JSON.stringify(value).length > MAX_READING_ENVELOPE_BYTES) {
    context.addIssue({ code: "custom", message: "加密文件过大。" });
  }
});

export type ReadingEnvelope = z.infer<typeof readingEnvelopeSchema>;

function cryptoProvider(): Crypto {
  const provider = globalThis.crypto;
  if (!provider?.subtle || !provider.getRandomValues) throw new Error("WebCrypto unavailable");
  return provider;
}

function checkPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 1_024) {
    throw new Error("Invalid passphrase");
  }
}

function encodeBase64url(value: Uint8Array<ArrayBuffer>): string {
  const chunks: string[] = [];
  // Small chunks work in browsers without spreading a large array onto the stack.
  for (let start = 0; start < value.length; start += 8_192) {
    chunks.push(String.fromCharCode(...value.subarray(start, start + 8_192)));
  }
  return btoa(chunks.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const provider = cryptoProvider();
  const passphraseBytes = encoder.encode(passphrase);
  try {
    const material = await provider.subtle.importKey("raw", passphraseBytes, "PBKDF2", false, ["deriveKey"]);
    return await provider.subtle.deriveKey({
      name: "PBKDF2", hash: "SHA-256", salt, iterations,
    }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    passphraseBytes.fill(0);
  }
}

/** Generate a portable 256-bit random sync passphrase. It is never persisted here. */
export function generateReadingPassphrase(): string {
  try {
    return encodeBase64url(cryptoProvider().getRandomValues(new Uint8Array(32)));
  } catch {
    throw new Error("无法生成同步口令，请使用支持安全连接的浏览器。");
  }
}

/** Encrypt only validated reading data, with a fresh salt and nonce on every call. */
export async function encryptReadingLibrary(library: ReadingLibrary, passphrase: string): Promise<ReadingEnvelope> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    checkPassphrase(passphrase);
    const parsed = readingLibrarySchema.parse(library);
    plaintext = encoder.encode(JSON.stringify(parsed));
    // Base64 ciphertext must fit inside the full envelope, so reject early.
    if (plaintext.byteLength + AUTH_TAG_BYTES > Math.floor(MAX_READING_ENVELOPE_BYTES * 3 / 4)) {
      throw new Error("Oversized reading data");
    }
    const provider = cryptoProvider();
    const salt = provider.getRandomValues(new Uint8Array(16));
    const iv = provider.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, ITERATIONS);
    const ciphertext = await provider.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: associatedData, tagLength: AUTH_TAG_BYTES * 8,
    }, key, plaintext);
    return readingEnvelopeSchema.parse({
      format: FORMAT,
      version: VERSION,
      kdf: { name: "PBKDF2-SHA256", iterations: ITERATIONS, salt: encodeBase64url(salt) },
      cipher: { name: "AES-256-GCM", iv: encodeBase64url(iv) },
      ciphertext: encodeBase64url(new Uint8Array(ciphertext)),
    });
  } catch {
    throw new Error("无法加密阅读资料，请检查资料格式与同步口令。");
  } finally {
    plaintext?.fill(0);
  }
}

/** Incorrect passwords, damaged files, and invalid plaintext receive one error. */
export async function decryptReadingLibrary(input: unknown, passphrase: string): Promise<ReadingLibrary> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    checkPassphrase(passphrase);
    let value = input;
    if (typeof input === "string") {
      if (input.length > MAX_READING_ENVELOPE_BYTES
        || encoder.encode(input).byteLength > MAX_READING_ENVELOPE_BYTES) {
        throw new Error("Oversized encrypted file");
      }
      value = JSON.parse(input);
    }
    const envelope = readingEnvelopeSchema.parse(value);
    const key = await deriveKey(passphrase, decodeBase64url(envelope.kdf.salt), envelope.kdf.iterations);
    const decrypted = await cryptoProvider().subtle.decrypt({
      name: "AES-GCM", iv: decodeBase64url(envelope.cipher.iv),
      additionalData: associatedData, tagLength: AUTH_TAG_BYTES * 8,
    }, key, decodeBase64url(envelope.ciphertext));
    plaintext = new Uint8Array(decrypted);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    return readingLibrarySchema.parse(JSON.parse(text));
  } catch {
    throw new Error("无法解密阅读资料，请检查同步口令与文件。");
  } finally {
    plaintext?.fill(0);
  }
}
