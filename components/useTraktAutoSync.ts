"use client";

import { useEffect, useRef, useState } from "react";
import { APP_BASE_PATH } from "@/lib/client";
import { clearTraktAuthorizationContext, completeTraktSessionAuthorization, createTraktAuthorization, fetchTraktLibrary, saveTraktAuthorizationContext, TraktError, type TraktSession } from "@/lib/trakt";
import { traktConnection } from "@/lib/trakt-connection";
import type { MediaLibrary } from "@/lib/media";

const PUBLIC_CLIENT_ID_KEY = "life-workbench:trakt-client-id";
export function useTraktAutoSync({ ready, onImport }: { ready: boolean; onImport: (library: MediaLibrary) => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<MediaLibrary | null>(null);
  const pendingSession = useRef<TraktSession | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const importer = useRef(onImport);
  importer.current = onImport;

  function begin() {
    const controller = new AbortController();
    controllerRef.current = controller;
    busyRef.current = true; setBusy(true); setError("");
    return controller;
  }
  function finish(controller: AbortController) {
    if (mounted.current && controllerRef.current === controller) {
      controllerRef.current = null; busyRef.current = false; setBusy(false);
    }
  }
  function report(cause: unknown, controller?: AbortController) {
    if (!mounted.current || controller?.signal.aborted) return;
    if (cause instanceof TraktError && (cause.code === "reauthorization" || cause.code === "unauthorized")) setConnected(false);
    setError(cause instanceof TraktError ? cause.message : "更新没有完成，已有影音记录仍然保留。可稍后重试。");
  }
  async function readLibrary(session: TraktSession, controller: AbortController, allowRefresh: boolean) {
    try { return { library: await fetchTraktLibrary(session.accessToken, session.clientId, { signal: controller.signal }), session }; }
    catch (cause) {
      if (!allowRefresh || !(cause instanceof TraktError) || cause.code !== "unauthorized") throw cause;
      const fresh = await traktConnection.getValidSession({ forceRefresh: true, rejectedAccessToken: session.accessToken, signal: controller.signal });
      if (!fresh) throw new TraktError("Trakt 连接已断开，请重新连接。", "reauthorization");
      return { library: await fetchTraktLibrary(fresh.accessToken, fresh.clientId, { signal: controller.signal }), session: fresh };
    }
  }
  async function refresh() {
    if (busyRef.current || !ready) return;
    const controller = begin();
    setMessage("正在自动更新 Trakt 影音资料…");
    try {
      const session = await traktConnection.getValidSession({ signal: controller.signal });
      if (!session || controller.signal.aborted) { if (!controller.signal.aborted) { setConnected(false); setMessage(""); } return; }
      setConnected(true); setClientId(session.clientId);
      const result = await readLibrary(session, controller, true);
      if (controller.signal.aborted) return;
      await importer.current(result.library);
      if (controller.signal.aborted) return;
      const syncedAt = result.library.syncedAt ?? new Date().toISOString();
      await traktConnection.markSynced(syncedAt, result.session.accessToken);
      if (!controller.signal.aborted && mounted.current) { setLastSynced(syncedAt); setMessage("影音已自动更新，原有感想和观看记录已保留。"); }
    } catch (cause) { report(cause, controller); if (!controller.signal.aborted) setMessage(""); }
    finally { finish(controller); }
  }
  useEffect(() => {
    mounted.current = true;
    setOrigin(window.location.origin);
    setRedirectUri(`${window.location.origin}${APP_BASE_PATH}/`);
    try { setClientId(sessionStorage.getItem(PUBLIC_CLIENT_ID_KEY) ?? ""); } catch { /* Public ID remains editable. */ }
    return () => { mounted.current = false; generation.current++; controllerRef.current?.abort(); controllerRef.current = null; busyRef.current = false; pendingSession.current = null; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed || !mounted.current || busyRef.current) return;
      const url = new URL(window.location.href);
      if (url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error"))) {
        const callback = url.href;
        for (const field of ["code", "state", "error", "error_description"]) url.searchParams.delete(field);
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
        const controller = begin();
        void (async () => {
          try {
            const session = await completeTraktSessionAuthorization(callback, sessionStorage, { signal: controller.signal });
            const result = await readLibrary(session, controller, false);
            if (!controller.signal.aborted && mounted.current) {
              pendingSession.current = result.session; setClientId(session.clientId); setPreview(result.library);
              setMessage("资料已读取。确认保存后，会在此浏览器启用每次打开网页自动更新。");
            }
          } catch (cause) { pendingSession.current = null; report(cause, controller); }
          finally { finish(controller); }
        })();
      } else {
        void (async () => {
          try {
            const record = await traktConnection.read();
            if (disposed || !mounted.current || !record) return;
            setConnected(true); setClientId(record.session.clientId); setLastSynced(record.syncedAt);
            await refresh();
          } catch (cause) { if (!disposed) report(cause); }
        })();
      }
    });
    return () => { disposed = true; };
    // Read once after the workbench has opened. View changes never start another sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function connect() {
    if (busyRef.current || !ready) return;
    const attempt = ++generation.current;
    const controller = begin(); setMessage(""); setPreview(null); pendingSession.current = null;
    try {
      const authorization = await createTraktAuthorization(clientId.trim(), redirectUri);
      if (!mounted.current || attempt !== generation.current || controller.signal.aborted) return;
      saveTraktAuthorizationContext(sessionStorage, authorization.context);
      sessionStorage.setItem(PUBLIC_CLIENT_ID_KEY, authorization.context.clientId);
      window.location.assign(authorization.authorizeUrl);
    } catch (cause) {
      try { clearTraktAuthorizationContext(sessionStorage); } catch { /* Safe message below. */ }
      report(cause, controller); finish(controller);
    }
  }
  function cancel() {
    generation.current++; controllerRef.current?.abort(); controllerRef.current = null; busyRef.current = false;
    pendingSession.current = null; setBusy(false); setPreview(null); setError(""); setMessage("本次读取已取消，原有记录保留。");
    try { clearTraktAuthorizationContext(sessionStorage); } catch { /* No data changed. */ }
  }
  async function save() {
    if (!preview || !pendingSession.current || busyRef.current) return;
    const library = preview;
    const session = pendingSession.current;
    const controller = begin();
    try {
      await importer.current(library);
      if (controller.signal.aborted) return;
      await traktConnection.save(session);
      if (controller.signal.aborted) return;
      const syncedAt = library.syncedAt ?? new Date().toISOString();
      await traktConnection.markSynced(syncedAt, session.accessToken);
      if (mounted.current && !controller.signal.aborted) {
        pendingSession.current = null; setPreview(null); setConnected(true); setLastSynced(syncedAt);
        setMessage("Trakt 资料已保存到影音，已启用每次打开网页自动更新。");
      }
    } catch (cause) { report(cause, controller); }
    finally { finish(controller); }
  }
  async function disconnect() {
    cancel();
    try {
      await traktConnection.disconnect();
      if (mounted.current) { setConnected(false); setLastSynced(null); setMessage("Trakt 连接已从此浏览器移除，影音记录保留。"); }
    } catch (cause) { report(cause); throw cause; }
  }
  function discard() { pendingSession.current = null; setPreview(null); setMessage(""); }
  return { clientId, setClientId, redirectUri, origin, busy, connected, lastSynced, error, message, preview, connect, cancel, save, refresh, disconnect, discard };
}
export type TraktController = ReturnType<typeof useTraktAutoSync>;
