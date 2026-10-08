import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptReadingLibrary, MAX_READING_ENVELOPE_BYTES, readingEnvelopeSchema } from "../lib/reading-envelope";
import { emptyReadingLibrary } from "../lib/reading";
import type { ReadingLibrary } from "../lib/reading";
import { WeReadError, WEREAD_GATEWAY } from "../lib/weread";
import { WeReadSyncError } from "../lib/weread-sync";
import { atomicWrite, PreviousSnapshotLookupError, PREVIOUS_SYNC_URL, runWeReadSyncCli, runWeReadSyncJob, SYNC_FILENAME, SYNC_STATUS_FILENAME } from "./weread-sync-job";

const now = new Date("2026-10-08T04:00:00.000Z");
const token = "offline-job-secret-not-a-real-key";
const passphrase = "offline-job-passphrase-never-published";
const library: ReadingLibrary = {
  version: 1, source: "weread", syncedAt: now.toISOString(),
  books: [{ id: "private-book-id", title: "测试中不得公开的书名", author: "作者", kind: "ebook", status: "reading" }],
  highlights: [{ id: "private-note", bookId: "private-book-id", text: "测试中不得公开的阅读原文", thought: "私人想法" }],
  stats: { mode: "overall", period: null, totalSeconds: 600, dailySeconds: [{ date: "2026-10-08", seconds: 600 }] },
};
// Structurally valid opaque ciphertext for retention tests. It is intentionally
// not decryptable; tests never send a real credential or use the public network.
const oldEnvelope = readingEnvelopeSchema.parse({
  format: "life-reading-encrypted", version: 1,
  kdf: { name: "PBKDF2-SHA256", iterations: 600_000, salt: "AAAAAAAAAAAAAAAAAAAAAA" },
  cipher: { name: "AES-256-GCM", iv: "AAAAAAAAAAAAAAAA" },
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
});

let output: string;
beforeEach(async () => { output = await mkdtemp(path.join(os.tmpdir(), "life-weread-job-test-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(output, { recursive: true, force: true });
});

function environment(extra: Record<string, string | undefined> = {}) {
  return { LIFE_SYNC_OUTPUT_DIR: output, WEREAD_API_KEY: token, WEREAD_SYNC_PASSPHRASE: passphrase, ...extra };
}
function noNetwork() {
  return vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Unexpected network call"));
}
function fakeClient() {
  return { shelf: vi.fn(), stats: vi.fn(), notebooks: vi.fn(), highlights: vi.fn(), thoughts: vi.fn(), disconnect: vi.fn() };
}
function offlineDependencies() {
  const client = fakeClient();
  return {
    client, fetch: noNetwork(), now: () => now,
    createClient: vi.fn(() => client), fetchLibrary: vi.fn(async () => library),
    encrypt: vi.fn(async () => oldEnvelope), decrypt: vi.fn(async () => emptyReadingLibrary()),
  };
}
async function readStatus() { return JSON.parse(await readFile(path.join(output, SYNC_STATUS_FILENAME), "utf8")); }
async function readCipher() { return JSON.parse(await readFile(path.join(output, SYNC_FILENAME), "utf8")); }

describe("free GitHub WeRead encrypted synchronization job", () => {
  it("does not create a client or make any request without both secrets", async () => {
    for (const absent of ["WEREAD_API_KEY", "WEREAD_SYNC_PASSPHRASE"]) {
      const deps = offlineDependencies();
      const result = await runWeReadSyncJob(environment({ [absent]: undefined }), deps);
      expect(result).toEqual({ version: 1, state: "needs_setup", updatedAt: now.toISOString(), failureCode: "configuration_missing" });
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(await readStatus()).toEqual(result);
      expect(await readdir(output)).toEqual([SYNC_STATUS_FILENAME]);
    }
  });

  it("preserves the previous encrypted file without secrets and fetches only the fixed public fallback", async () => {
    const deps = offlineDependencies();
    deps.fetch.mockResolvedValue(new Response(JSON.stringify(oldEnvelope)));
    const status = await runWeReadSyncJob(environment({ WEREAD_API_KEY: undefined, LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL }), deps);
    expect(status.state).toBe("needs_setup");
    expect(await readCipher()).toEqual(oldEnvelope);
    expect(deps.fetch).toHaveBeenCalledExactlyOnceWith(PREVIOUS_SYNC_URL, expect.objectContaining({ method: "GET", redirect: "error", credentials: "omit" }));
    expect(deps.fetch.mock.calls[0][1]?.headers).toBeUndefined();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it("rejects arbitrary fallback URLs, malformed settings and weak passphrases before official requests", async () => {
    for (const extra of [
      { WEREAD_SYNC_PASSPHRASE: "short" }, { WEREAD_API_KEY: `${token}\r\nInjected: header` },
      { WEREAD_SYNC_INCLUDE_NOTES: "yes" }, { WEREAD_SYNC_RESET_HISTORY: "yes" },
    ]) {
      const deps = offlineDependencies();
      expect(await runWeReadSyncJob(environment(extra), deps)).toMatchObject({ state: "failed", failureCode: "invalid_configuration" });
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(deps.createClient).not.toHaveBeenCalled();
    }
  });

  it("blocks arbitrary previous URLs without requests or writes", async () => {
    for (const url of ["https://untrusted.example/snapshot.json", `${PREVIOUS_SYNC_URL}?redirect=elsewhere`]) {
      const deps = offlineDependencies();
      await expect(runWeReadSyncJob(environment({ LIFE_SYNC_PREVIOUS_URL: url }), deps)).rejects.toBeInstanceOf(PreviousSnapshotLookupError);
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(await readdir(output)).toEqual([]);
    }
  });

  it("treats only a public 404 as first setup and blocks deployment on an unverified previous snapshot", async () => {
    const deps = offlineDependencies();
    deps.fetch.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await runWeReadSyncJob(environment({ LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL }), deps)).toMatchObject({ state: "ready" });
    expect(deps.fetchLibrary).toHaveBeenCalledOnce();
    await rm(path.join(output, SYNC_FILENAME));
    await rm(path.join(output, SYNC_STATUS_FILENAME));
    for (const status of [401, 403, 500, 502]) {
      const failed = offlineDependencies();
      failed.fetch.mockResolvedValue(new Response(null, { status }));
      await expect(runWeReadSyncJob(environment({ LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL }), failed)).rejects.toBeInstanceOf(PreviousSnapshotLookupError);
      expect(failed.createClient).not.toHaveBeenCalled();
      expect(await readdir(output)).toEqual([]);
    }
    const unavailable = offlineDependencies();
    await expect(runWeReadSyncJob(environment({ LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL, WEREAD_API_KEY: undefined }), unavailable)).rejects.toBeInstanceOf(PreviousSnapshotLookupError);
    expect(unavailable.createClient).not.toHaveBeenCalled();
    expect(await readdir(output)).toEqual([]);
  });

  it("publishes real authenticated encryption, safe metadata and no reading plaintext or secret values", async () => {
    const deps = offlineDependencies();
    const { encrypt: _fakeEncrypt, ...actualEncryption } = deps;
    const result = await runWeReadSyncJob(environment(), actualEncryption);
    expect(result).toEqual({ version: 1, state: "ready", updatedAt: now.toISOString() });
    const text = await readFile(path.join(output, SYNC_FILENAME), "utf8");
    const status = await readFile(path.join(output, SYNC_STATUS_FILENAME), "utf8");
    for (const privateText of [token, passphrase, library.books[0].title, library.highlights[0].text, library.highlights[0].thought!]) {
      expect(text + status).not.toContain(privateText);
    }
    expect(await decryptReadingLibrary(text, passphrase)).toEqual(library);
    expect(await readdir(output)).toEqual([SYNC_STATUS_FILENAME, SYNC_FILENAME].sort());
    expect(deps.fetchLibrary).toHaveBeenCalledWith(deps.client, { now, includeNotes: false });
    expect(deps.client.disconnect).toHaveBeenCalledOnce();
  });

  it("merges prior notes and daily history before encryption, while current totals remain authoritative", async () => {
    await writeFile(path.join(output, SYNC_FILENAME), JSON.stringify(oldEnvelope));
    const deps = offlineDependencies();
    deps.decrypt.mockResolvedValue({ ...library, stats: { ...library.stats!, totalSeconds: 100, dailySeconds: [{ date: "2025-01-01", seconds: 100 }] } });
    deps.fetchLibrary.mockResolvedValue({ ...library, highlights: [], stats: { ...library.stats!, totalSeconds: 800 } });
    await runWeReadSyncJob(environment(), deps);
    expect(deps.encrypt).toHaveBeenCalledWith(expect.objectContaining({
      highlights: library.highlights,
      stats: expect.objectContaining({ totalSeconds: 800, dailySeconds: [{ date: "2025-01-01", seconds: 100 }, { date: "2026-10-08", seconds: 600 }] }),
    }), passphrase);
  });

  it("keeps a maximum-size valid encrypted envelope readable without adding an extra newline byte", async () => {
    const overhead = JSON.stringify(oldEnvelope).length - oldEnvelope.ciphertext.length;
    const maximumEnvelope = readingEnvelopeSchema.parse({
      ...oldEnvelope, ciphertext: "A".repeat(MAX_READING_ENVELOPE_BYTES - overhead),
    });
    const deps = offlineDependencies();
    deps.encrypt.mockResolvedValue(maximumEnvelope);
    expect(await runWeReadSyncJob(environment(), deps)).toMatchObject({ state: "ready" });
    const persisted = await readFile(path.join(output, SYNC_FILENAME), "utf8");
    expect(Buffer.byteLength(persisted, "utf8")).toBe(MAX_READING_ENVELOPE_BYTES);
    expect(persisted.endsWith("\n")).toBe(false);
    expect(readingEnvelopeSchema.safeParse(JSON.parse(persisted)).success).toBe(true);
  });

  it("keeps old ciphertext and performs no official request when the current passphrase cannot unlock history", async () => {
    await writeFile(path.join(output, SYNC_FILENAME), JSON.stringify(oldEnvelope));
    const deps = offlineDependencies();
    deps.decrypt.mockRejectedValue(new Error(`Do not reflect ${passphrase}`));
    const result = await runWeReadSyncJob(environment(), deps);
    expect(result).toMatchObject({ state: "preserved", failureCode: "previous_decryption_failed" });
    expect(deps.fetchLibrary).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(await readCipher()).toEqual(oldEnvelope);
    expect(JSON.stringify(result)).not.toContain(passphrase);
  });

  it("allows history reset only explicitly and still retains old ciphertext if the new read fails", async () => {
    await writeFile(path.join(output, SYNC_FILENAME), JSON.stringify(oldEnvelope));
    const deps = offlineDependencies();
    deps.decrypt.mockRejectedValue(new Error("Wrong passphrase"));
    deps.fetchLibrary.mockRejectedValue(new WeReadError("NetworkError", token));
    const result = await runWeReadSyncJob(environment({ WEREAD_SYNC_RESET_HISTORY: "true" }), deps);
    expect(result).toMatchObject({ state: "preserved", failureCode: "network_error" });
    expect(deps.decrypt).not.toHaveBeenCalled();
    expect(deps.fetchLibrary).toHaveBeenCalledOnce();
    expect(await readCipher()).toEqual(oldEnvelope);
    deps.fetchLibrary.mockResolvedValue(library);
    expect(await runWeReadSyncJob(environment({ WEREAD_SYNC_RESET_HISTORY: "true", WEREAD_SYNC_INCLUDE_NOTES: "true" }), deps)).toMatchObject({ state: "ready" });
    expect(deps.fetchLibrary).toHaveBeenLastCalledWith(deps.client, { now, includeNotes: true });
    expect(deps.encrypt).toHaveBeenLastCalledWith(library, passphrase);
  });

  it("retains a validated prior public snapshot on failure and never publishes an incomplete library", async () => {
    const deps = offlineDependencies();
    deps.fetch.mockResolvedValue(new Response(JSON.stringify(oldEnvelope)));
    deps.fetchLibrary.mockRejectedValue(new WeReadSyncError("LimitExceeded", `Private gateway message ${token}`));
    const result = await runWeReadSyncJob(environment({ LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL }), deps);
    expect(result).toMatchObject({ state: "preserved", failureCode: "limit_exceeded" });
    expect(await readCipher()).toEqual(oldEnvelope);
    expect(deps.encrypt).not.toHaveBeenCalled();
    expect(await readStatus()).toEqual(result);
  });

  it.each([
    ["notebooks", "notebook_limit_exceeded"],
    ["notes", "note_limit_exceeded"],
  ] as const)("identifies a %s limit safely while preserving the prior encrypted snapshot", async (limitKind, expectedCode) => {
    await writeFile(path.join(output, SYNC_FILENAME), JSON.stringify(oldEnvelope));
    const deps = offlineDependencies();
    deps.fetchLibrary.mockRejectedValue(new WeReadSyncError("LimitExceeded", `Private response detail ${token} ${library.books[0].title}`, limitKind));
    const status = await runWeReadSyncJob(environment(), deps);
    expect(status).toMatchObject({ state: "preserved", failureCode: expectedCode });
    expect(await readCipher()).toEqual(oldEnvelope);
    expect(await readStatus()).toEqual(status);
    expect(deps.encrypt).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(library.books[0].title);
  });

  it("rejects oversized, corrupted or plaintext previous files rather than publishing them", async () => {
    for (const previousResponse of [
      new Response(JSON.stringify({ ...oldEnvelope, cipher: { ...oldEnvelope.cipher, iv: "malformed" } })),
      new Response(JSON.stringify(library)),
      new Response(JSON.stringify(oldEnvelope), { headers: { "content-length": "20000001" } }),
    ]) {
      await writeFile(path.join(output, SYNC_FILENAME), JSON.stringify(library));
      const deps = offlineDependencies();
      deps.fetch.mockResolvedValue(previousResponse);
      deps.fetchLibrary.mockRejectedValue(new Error("Failed"));
      await expect(runWeReadSyncJob(environment({ LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL }), deps)).rejects.toBeInstanceOf(PreviousSnapshotLookupError);
      expect(deps.createClient).not.toHaveBeenCalled();
      expect(await readdir(output)).toEqual([]);
    }
  });

  it("stops after an upgrade requirement, and never retries or makes a later gateway request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ upgrade_info: { message: `${token} ${passphrase}` } })));
    const result = await runWeReadSyncJob(environment(), { fetch, now: () => now });
    expect(result).toMatchObject({ state: "failed", failureCode: "upgrade_required" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(WEREAD_GATEWAY);
    expect(await readdir(output)).toEqual([SYNC_STATUS_FILENAME]);
  });

  it("maps authorization rejection safely and rejects invalid reading content without encryption", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ errcode: 401 }), { status: 401 }));
    expect(await runWeReadSyncJob(environment(), { fetch, now: () => now })).toMatchObject({ state: "failed", failureCode: "authorization_failed" });
    const deps = offlineDependencies();
    deps.fetchLibrary.mockResolvedValue({ ...library, books: [] });
    expect(await runWeReadSyncJob(environment(), deps)).toMatchObject({ state: "failed", failureCode: "invalid_data" });
    expect(deps.encrypt).not.toHaveBeenCalled();
  });

  it("publishes atomic complete files without leftover temporary artifacts and keeps an old file on a write failure", async () => {
    const filename = path.join(output, SYNC_FILENAME);
    await atomicWrite(filename, JSON.stringify(oldEnvelope));
    await atomicWrite(filename, JSON.stringify(oldEnvelope));
    expect(await readdir(output)).toEqual([SYNC_FILENAME]);
    const deps = offlineDependencies();
    const privateFailure = `filesystem detail ${token} ${passphrase}`;
    await expect(runWeReadSyncJob(environment(), {
      ...deps, writeAtomic: vi.fn(async () => { throw new Error(privateFailure); }),
    })).rejects.toThrow(privateFailure);
    expect(await readCipher()).toEqual(oldEnvelope);
    expect(await readdir(output)).toEqual([SYNC_FILENAME]);
  });

  it("cleans an atomic temporary file when rename fails and leaves existing contents intact", async () => {
    const existing = path.join(output, "existing-directory");
    await mkdir(existing);
    await writeFile(path.join(existing, "retained.txt"), "retained");
    await expect(atomicWrite(existing, "safe replacement text")).rejects.toThrow();
    expect(await readFile(path.join(existing, "retained.txt"), "utf8")).toBe("retained");
    expect(await readdir(output)).toEqual(["existing-directory"]);
  });

  it("fails the CLI deployment gate safely if prior snapshot TLS or network retrieval fails", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`TLS detail ${token} ${passphrase}`));
    vi.stubGlobal("fetch", fetch);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const canPublish = await runWeReadSyncCli(environment({ LIFE_SYNC_PREVIOUS_URL: PREVIOUS_SYNC_URL }));
    expect(canPublish).toBe(false);
    expect(await readdir(output)).toEqual([]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(PREVIOUS_SYNC_URL, expect.objectContaining({ method: "GET" }));
    const publicText = JSON.stringify([error.mock.calls, log.mock.calls]);
    expect(publicText).toContain("Deployment is stopped");
    expect(publicText).not.toContain(token);
    expect(publicText).not.toContain(passphrase);
  });

  it("logs only safe fixed messages and writes safe GitHub summary/output on a real CLI gateway failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`raw fetch text ${token} ${passphrase} ${library.books[0].title}`));
    vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const summaryPath = path.join(output, "test-summary.md");
    const outputPath = path.join(output, "test-output.txt");
    await runWeReadSyncCli(environment({ GITHUB_STEP_SUMMARY: summaryPath, GITHUB_OUTPUT: outputPath }));
    const publicText = JSON.stringify([log.mock.calls, error.mock.calls]) + await readFile(summaryPath, "utf8") + await readFile(outputPath, "utf8");
    for (const privateText of [token, passphrase, library.books[0].title]) expect(publicText).not.toContain(privateText);
    expect(publicText).toContain("network_error");
    expect(await readFile(outputPath, "utf8")).toBe("state=failed\n");
  });
});
