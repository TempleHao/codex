import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decryptReadingLibrary, encryptReadingLibrary, MAX_READING_ENVELOPE_BYTES, readingEnvelopeSchema } from "../lib/reading-envelope";
import type { ReadingEnvelope } from "../lib/reading-envelope";
import { mergeReadingLibraries, readingLibrarySchema } from "../lib/reading";
import type { ReadingLibrary } from "../lib/reading";
import { readingSyncStatusSchema } from "../lib/reading-sync-status";
import type { ReadingSyncStatus } from "../lib/reading-sync-status";
import { WeReadClient, WeReadError, UpgradeRequired } from "../lib/weread";
import { fetchWeReadLibrary, WeReadSyncError } from "../lib/weread-sync";
import type { WeReadSyncClient } from "../lib/weread-sync";

export const SYNC_FILENAME = "weread-sync.json";
export const SYNC_STATUS_FILENAME = "weread-sync-status.json";
export const PREVIOUS_SYNC_URL = "https://templehao.github.io/codex/weread-sync.json";

export class PreviousSnapshotLookupError extends Error {
  constructor() {
    super("Previous encrypted snapshot could not be safely retrieved; deployment must stop to preserve reading history.");
    this.name = "PreviousSnapshotLookupError";
  }
}

type Environment = Record<string, string | undefined>;
type FailureCode = NonNullable<ReadingSyncStatus["failureCode"]>;
type SyncClient = WeReadSyncClient & { disconnect?: () => void };

export interface SyncJobDependencies {
  fetch?: typeof globalThis.fetch;
  createClient?: (token: string, fetch: typeof globalThis.fetch) => SyncClient;
  fetchLibrary?: typeof fetchWeReadLibrary;
  encrypt?: typeof encryptReadingLibrary;
  decrypt?: typeof decryptReadingLibrary;
  writeAtomic?: typeof atomicWrite;
  now?: () => Date;
}

/** Publish only a complete file. A failure never truncates the prior ciphertext. */
export async function atomicWrite(filename: string, text: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseEnvelope(text: string): ReadingEnvelope | null {
  if (Buffer.byteLength(text, "utf8") > MAX_READING_ENVELOPE_BYTES) return null;
  try {
    const parsed = readingEnvelopeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

async function boundedResponseText(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_READING_ENVELOPE_BYTES)) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_READING_ENVELOPE_BYTES) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

/**
 * The fallback URL is deliberately fixed. Neither redirects nor user-provided
 * hosts can turn an Actions secret-bearing job into a general proxy.
 */
async function loadPrevious(output: string, previousUrl: string | undefined, fetchImpl: typeof globalThis.fetch): Promise<ReadingEnvelope | null> {
  const filename = path.join(output, SYNC_FILENAME);
  let localInformation: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    localInformation = await stat(filename);
  } catch (error) {
    // Only a genuinely missing local file is a fresh export. Permission and
    // other I/O errors must not be mistaken for a safe reset of history.
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new PreviousSnapshotLookupError();
  }
  if (localInformation) {
    try {
      if (localInformation.isFile() && localInformation.size <= MAX_READING_ENVELOPE_BYTES) {
        const local = parseEnvelope(await readFile(filename, "utf8"));
        if (local) return local;
      }
      // Malformed local files may contain arbitrary text and must never be
      // uploaded under the encrypted snapshot filename.
      await rm(filename, { force: true });
    } catch { throw new PreviousSnapshotLookupError(); }
  }
  if (!previousUrl) return null;
  // Validation is also performed before this function is called.
  if (previousUrl !== PREVIOUS_SYNC_URL) throw new PreviousSnapshotLookupError();
  try {
    const response = await fetchImpl(previousUrl, {
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) throw new PreviousSnapshotLookupError();
    const text = await boundedResponseText(response);
    const envelope = text === null ? null : parseEnvelope(text);
    if (!envelope) throw new PreviousSnapshotLookupError();
    return envelope;
  } catch { throw new PreviousSnapshotLookupError(); }
}

function validConfiguration(env: Environment): boolean {
  const token = env.WEREAD_API_KEY ?? "";
  const passphrase = env.WEREAD_SYNC_PASSPHRASE ?? "";
  return token.length <= 1_024 && !/[\r\n]/.test(token)
    && passphrase.length >= 16 && passphrase.length <= 1_024
    && (!env.WEREAD_SYNC_INCLUDE_NOTES || ["true", "false"].includes(env.WEREAD_SYNC_INCLUDE_NOTES))
    && (!env.WEREAD_SYNC_RESET_HISTORY || ["true", "false"].includes(env.WEREAD_SYNC_RESET_HISTORY))
    && (!env.LIFE_SYNC_PREVIOUS_URL || env.LIFE_SYNC_PREVIOUS_URL === PREVIOUS_SYNC_URL);
}

function failureCode(error: unknown, lastHttpStatus?: number): FailureCode {
  if (error instanceof UpgradeRequired) return "upgrade_required";
  if (error instanceof WeReadSyncError) {
    return error.code === "LimitExceeded" ? "limit_exceeded" : "invalid_data";
  }
  if (error instanceof WeReadError) {
    if (error.code === "NetworkError" || error.code === "Timeout") return "network_error";
    if (error.code === "HttpError" && (lastHttpStatus === 401 || lastHttpStatus === 403)) return "authorization_failed";
    if (error.code === "InvalidResponse") return "invalid_data";
    if (error.code === "InvalidInput") return "invalid_configuration";
  }
  // Raw errors, gateway messages, book titles and credentials are never exposed.
  return "read_failed";
}

/**
 * Secrets and plaintext exist only in memory. The only published data is a
 * validated encrypted reading envelope and a small fixed-enumeration status.
 */
export async function runWeReadSyncJob(env: Environment, dependencies: SyncJobDependencies = {}): Promise<ReadingSyncStatus> {
  const output = path.resolve(env.LIFE_SYNC_OUTPUT_DIR ?? "preview-out");
  await mkdir(output, { recursive: true });
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const persist = dependencies.writeAtomic ?? atomicWrite;
  const now = dependencies.now?.() ?? new Date();
  const updatedAt = now.toISOString();
  const previous = await loadPrevious(output, env.LIFE_SYNC_PREVIOUS_URL, fetchImpl);
  let status: ReadingSyncStatus;
  let nextEnvelope: ReadingEnvelope | null = previous;
  let lastHttpStatus: number | undefined;
  let client: SyncClient | undefined;

  const missing = !(env.WEREAD_API_KEY?.trim() && env.WEREAD_SYNC_PASSPHRASE?.trim());
  if (missing) {
    status = { version: 1, state: "needs_setup", updatedAt, failureCode: "configuration_missing" };
  } else if (!validConfiguration(env)) {
    status = { version: 1, state: previous ? "preserved" : "failed", updatedAt, failureCode: "invalid_configuration" };
  } else {
    let before: ReadingLibrary | undefined;
    let canRead = true;
    if (previous && env.WEREAD_SYNC_RESET_HISTORY !== "true") {
      try { before = await (dependencies.decrypt ?? decryptReadingLibrary)(previous, env.WEREAD_SYNC_PASSPHRASE!); }
      catch { canRead = false; }
    }
    if (!canRead) {
      status = { version: 1, state: "preserved", updatedAt, failureCode: "previous_decryption_failed" };
    } else {
      try {
        const transport: typeof globalThis.fetch = async (url, init) => {
          const response = await fetchImpl(url, init);
          lastHttpStatus = response.status;
          return response;
        };
        client = (dependencies.createClient ?? ((token, fetch) => new WeReadClient({ token, fetch })))(env.WEREAD_API_KEY!, transport);
        const parsed = readingLibrarySchema.safeParse(await (dependencies.fetchLibrary ?? fetchWeReadLibrary)(client, {
          now, includeNotes: env.WEREAD_SYNC_INCLUDE_NOTES === "true",
        }));
        if (!parsed.success) throw new WeReadSyncError("InvalidData", "Invalid reading snapshot");
        const incoming = parsed.data;
        const library = before ? mergeReadingLibraries(before, incoming) : incoming;
        nextEnvelope = readingEnvelopeSchema.parse(await (dependencies.encrypt ?? encryptReadingLibrary)(library, env.WEREAD_SYNC_PASSPHRASE!));
        status = { version: 1, state: "ready", updatedAt };
      } catch (error) {
        status = { version: 1, state: previous ? "preserved" : "failed", updatedAt, failureCode: failureCode(error, lastHttpStatus) };
      } finally { client?.disconnect?.(); }
    }
  }

  status = readingSyncStatusSchema.parse(status);
  // No file is created for a failed partial result. A previous valid snapshot is
  // copied into a freshly built export so code releases cannot erase it.
  // The envelope schema bounds the complete JSON text. Appending even a newline
  // would make a valid maximum-size snapshot unreadable on the next sync.
  if (nextEnvelope) await persist(path.join(output, SYNC_FILENAME), JSON.stringify(nextEnvelope));
  await persist(path.join(output, SYNC_STATUS_FILENAME), `${JSON.stringify(status)}\n`);
  return status;
}

const SUMMARIES: Record<ReadingSyncStatus["state"], string> = {
  needs_setup: "WeRead sync needs configuration. Add WEREAD_API_KEY and WEREAD_SYNC_PASSPHRASE as repository Actions secrets; no official reading request was made.",
  ready: "WeRead sync succeeded. Only encrypted reading data and a safe status file are included in the Pages artifact.",
  failed: "WeRead sync could not complete. No partial reading data was published. The application release can continue; check the safe status code and retry.",
  preserved: "WeRead sync could not update. The previous encrypted snapshot is preserved. Check the safe status code and retry; an incorrect sync passphrase does not reset history.",
};

export async function runWeReadSyncCli(env: Environment = process.env): Promise<boolean> {
  try {
    const status = await runWeReadSyncJob(env);
    const summary = `${SUMMARIES[status.state]}${status.failureCode ? ` Status: ${status.failureCode}.` : ""}\n`;
    console.log(summary.trim());
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### WeRead synchronization\n\n${summary}`);
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `state=${status.state}\n`);
    return true;
  } catch (error) {
    // Filesystem/runtime failures receive the same fixed message. Do not print
    // raw Error objects or stacks: dependencies may include credential strings.
    const summary = error instanceof PreviousSnapshotLookupError
      ? "The previous encrypted WeRead snapshot could not be safely retrieved. Deployment is stopped to preserve existing reading history. Retry when the existing Pages snapshot is reachable; no credential or reading content is logged.\n"
      : "WeRead synchronization could not write its encrypted output. Deployment is stopped to preserve existing reading history. No credential or reading content is logged.\n";
    console.error(summary.trim());
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### WeRead synchronization\n\n${summary}`).catch(() => {});
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, "state=failed\n").catch(() => {});
    return false;
  }
}
