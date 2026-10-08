import { describe, expect, it, vi } from "vitest";
import { createTraktConnection, type TraktConnectionRecord, type TraktConnectionStore } from "./trakt-connection";
import { TraktError, type TraktSession } from "./trakt";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const session = (expiresAt = NOW + 60_000): TraktSession => ({ accessToken: "private-access", refreshToken: "private-refresh", expiresAt, clientId: "client-id", redirectUri: "https://example.com/callback/" });
function storage(initial: TraktConnectionRecord | null = { session: session(), syncedAt: null }) {
  let value = initial;
  const store: TraktConnectionStore = { read: async () => value, write: async record => { value = record; } };
  return { store, value: () => value };
}
function locks() {
  let tail = Promise.resolve();
  return { request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const result = tail.then(callback);
    tail = result.then(() => {}, () => {});
    return result;
  } };
}
function response() { return new Response(JSON.stringify({ access_token: "private-rotated-access", refresh_token: "private-rotated-refresh", token_type: "Bearer", created_at: NOW / 1_000, expires_in: 604_800 })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }

describe("persistent Trakt connection", () => {
  it("reuses a fresh session, stores sync time separately, and deletes only its connection", async () => {
    const data = storage({ session: session(NOW + 60_001), syncedAt: null });
    const connection = createTraktConnection({ store: data.store, locks: locks(), now: () => NOW });
    const fetcher = vi.fn<typeof fetch>();
    expect(await connection.getValidSession({ fetch: fetcher })).toEqual(session(NOW + 60_001));
    expect(fetcher).not.toHaveBeenCalled();
    await connection.markSynced(new Date(NOW).toISOString(), "private-access");
    expect((await connection.read())?.syncedAt).toBe(new Date(NOW).toISOString());
    await connection.disconnect();
    expect(await connection.read()).toBeNull();
  });
  it("refreshes at the 60 second boundary and rotates atomically across tabs and same-page callers", async () => {
    const data = storage(); const manager = locks();
    const first = createTraktConnection({ store: data.store, locks: manager, now: () => NOW });
    const second = createTraktConnection({ store: data.store, locks: manager, now: () => NOW });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const results = await Promise.all([first.getValidSession({ fetch: fetcher }), first.getValidSession({ fetch: fetcher }), second.getValidSession({ fetch: fetcher })]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(results.every(value => value?.refreshToken === "private-rotated-refresh")).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ client_id: "client-id", redirect_uri: "https://example.com/callback/", grant_type: "refresh_token", refresh_token: "private-refresh" });
    expect(data.value()?.session).toMatchObject({ accessToken: "private-rotated-access", expiresAt: NOW + 604_800_000 });
  });
  it("avoids another forced refresh when another tab already replaced a rejected access token", async () => {
    const data = storage({ session: session(NOW + 604_800_000), syncedAt: null }); const manager = locks();
    const a = createTraktConnection({ store: data.store, locks: manager, now: () => NOW });
    const b = createTraktConnection({ store: data.store, locks: manager, now: () => NOW });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await Promise.all([a.getValidSession({ fetch: fetcher, forceRefresh: true, rejectedAccessToken: "private-access" }), b.getValidSession({ fetch: fetcher, forceRefresh: true, rejectedAccessToken: "private-access" })]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("fails closed without cross-tab locks and keeps the stored session", async () => {
    const data = storage(); const connection = createTraktConnection({ store: data.store, locks: null, now: () => NOW });
    const fetcher = vi.fn<typeof fetch>();
    await expect(connection.getValidSession({ fetch: fetcher })).rejects.toMatchObject({ code: "refresh-lock" });
    expect(fetcher).not.toHaveBeenCalled(); expect(data.value()?.session).toEqual(session());
  });
  it.each([500, 429])("keeps the old session after transient HTTP %s and redacts errors", async status => {
    const data = storage(); const connection = createTraktConnection({ store: data.store, locks: locks(), now: () => NOW });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "private-refresh" }), { status }));
    const error = await connection.getValidSession({ fetch: fetcher }).catch(error => error);
    expect(error).toBeInstanceOf(TraktError); expect(error.message).not.toContain("private"); expect(data.value()?.session).toEqual(session());
  });
  it("deletes invalid_grant and exposes only a reauthorization code", async () => {
    const data = storage(); const connection = createTraktConnection({ store: data.store, locks: locks(), now: () => NOW });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant", error_description: "private-refresh" }), { status: 400 }));
    await expect(connection.getValidSession({ fetch: fetcher })).rejects.toMatchObject({ code: "reauthorization", message: "Trakt 授权已失效，请重新连接。" });
    expect(data.value()).toBeNull();
  });
  it("a disconnect during refresh prevents credentials being saved again", async () => {
    const data = storage(); const connection = createTraktConnection({ store: data.store, locks: locks(), now: () => NOW });
    const pending = deferred<Response>(); const started = deferred<void>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => { started.resolve(); return pending.promise; });
    const refresh = connection.getValidSession({ fetch: fetcher }); await started.promise;
    const disconnect = connection.disconnect(); pending.resolve(response());
    expect(await refresh).toBeNull(); await disconnect; expect(await connection.read()).toBeNull();
    await connection.markSynced(new Date(NOW).toISOString(), "private-rotated-access"); expect(data.value()).toBeNull();
  });
  it("new authorization during an old refresh wins", async () => {
    const data = storage(); const connection = createTraktConnection({ store: data.store, locks: locks(), now: () => NOW });
    const pending = deferred<Response>(); const started = deferred<void>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => { started.resolve(); return pending.promise; });
    const refresh = connection.getValidSession({ fetch: fetcher }); await started.promise;
    const replacement = { ...session(NOW + 604_800_000), accessToken: "private-new-account", refreshToken: "private-new-refresh" };
    const save = connection.save(replacement); pending.resolve(response());
    expect(await refresh).toBeNull(); await save; expect(data.value()?.session).toEqual(replacement);
  });
});
