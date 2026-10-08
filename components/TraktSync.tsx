"use client";

import { useEffect, useRef, useState } from "react";
import { APP_BASE_PATH } from "@/lib/client";
import { clearTraktAuthorizationContext, completeTraktAuthorization, createTraktAuthorization, fetchTraktLibrary, saveTraktAuthorizationContext, TraktError } from "@/lib/trakt";
import type { MediaLibrary } from "@/lib/media";

const PUBLIC_CLIENT_ID_KEY = "life-workbench:trakt-client-id";
export default function TraktSync({ onImport }: { onImport: (library: MediaLibrary) => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<MediaLibrary | null>(null);
  const [copyNote, setCopyNote] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const attemptRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    mountedRef.current = true;
    setOrigin(window.location.origin);
    setRedirectUri(`${window.location.origin}${APP_BASE_PATH}/`);
    try { setClientId(sessionStorage.getItem(PUBLIC_CLIENT_ID_KEY) ?? ""); } catch { /* An editable public ID still works. */ }
    // Delay one microtask so development Strict Mode can clean up its probe mount
    // before consuming the one-use authorization callback.
    queueMicrotask(() => {
      if (!mounted) return;
      const url = new URL(window.location.href);
      if (!url.searchParams.has("state") || !(url.searchParams.has("code") || url.searchParams.has("error"))) return;
      const callback = url.href;
      for (const field of ["code", "state", "error", "error_description"]) url.searchParams.delete(field);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      const controller = new AbortController();
      abortRef.current = controller;
      busyRef.current = true; setBusy(true); setError("");
      sectionRef.current?.scrollIntoView({ block: "start" });
      void (async () => {
        let accessToken = "";
        try {
          const authorization = await completeTraktAuthorization(callback, sessionStorage, { signal: controller.signal });
          accessToken = authorization.accessToken;
          if (mounted) setClientId(authorization.clientId);
          const library = await fetchTraktLibrary(accessToken, authorization.clientId, { signal: controller.signal });
          if (mounted) { setPreview(library); setMessage("Trakt 资料已读取，请先预览再保存。"); }
        } catch (cause) {
          if (mounted && !controller.signal.aborted) setError(cause instanceof TraktError ? cause.message : "Trakt 连接没有完成，请重新授权。已有影音记录未更改。");
        } finally {
          accessToken = "";
          if (mounted && abortRef.current === controller) { abortRef.current = null; busyRef.current = false; setBusy(false); }
        }
      })();
    });
    return () => { mounted = false; mountedRef.current = false; attemptRef.current += 1; abortRef.current?.abort(); abortRef.current = null; busyRef.current = false; };
  }, []);

  async function connect() {
    if (busyRef.current) return;
    const attempt = ++attemptRef.current;
    busyRef.current = true; setBusy(true); setError(""); setMessage(""); setPreview(null);
    try {
      const authorization = await createTraktAuthorization(clientId.trim(), redirectUri);
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      saveTraktAuthorizationContext(sessionStorage, authorization.context);
      sessionStorage.setItem(PUBLIC_CLIENT_ID_KEY, authorization.context.clientId);
      window.location.assign(authorization.authorizeUrl);
    } catch (cause) {
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      try { clearTraktAuthorizationContext(sessionStorage); } catch { /* Report the safe storage error below. */ }
      setError(cause instanceof TraktError ? cause.message : "无法开始授权，请确认浏览器允许当前页面的临时存储。");
      busyRef.current = false; setBusy(false);
    }
  }
  function cancel() {
    attemptRef.current += 1;
    abortRef.current?.abort(); abortRef.current = null;
    try { clearTraktAuthorizationContext(sessionStorage); } catch { /* Cancellation still leaves records unchanged. */ }
    busyRef.current = false; setBusy(false); setPreview(null); setError(""); setMessage("已取消本次读取，现有影音资料未更改。");
  }
  async function save() {
    if (!preview || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await onImport(preview); setPreview(null); setMessage("Trakt 资料已保存到影音，原有记录和感想已保留。"); }
    catch { setError("保存没有完成，预览仍在这里，请重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopyNote("已复制。"); }
    catch { setCopyNote("当前浏览器无法自动复制，请选择上方文字复制。"); }
  }
  return <section className="media-card trakt-sync" ref={sectionRef} aria-labelledby="trakt-sync-heading">
    <p className="eyebrow">TRAKT</p><h2 id="trakt-sync-heading">连接自己的影音足迹</h2>
    <p>跳转到 Trakt 授权，带回观影历史、想看片单和本人评分。授权结束后回到这里，先预览，再保存。</p>
    <details className="trakt-config"><summary>首次配置 Trakt 应用</summary><ol><li>在 <a href="https://developer.trakt.tv/apps" target="_blank" rel="noopener noreferrer">Trakt 开发者页面</a>创建自己的应用，按官方要求连接已验证的 GitHub 账户。</li><li>回调地址（Redirect URI）：<code>{redirectUri || "页面载入后显示"}</code><button type="button" className="text-button" onClick={() => void copy(redirectUri)}>复制回调地址</button></li><li>JavaScript / CORS 来源只填域名来源，不带仓库路径：<code>{origin || "页面载入后显示"}</code><button type="button" className="text-button" onClick={() => void copy(origin)}>复制 CORS 来源</button></li><li>把应用的公开 Client ID 填到下方，然后跳转授权。此网页使用 PKCE，不需要 Client Secret。</li></ol>{copyNote && <p role="status">{copyNote}</p>}</details>
    {error && <p className="media-error" role="alert">{error}</p>}{message && <p className="media-message" role="status">{message}</p>}
    {preview ? <div className="trakt-preview"><h3>已读取，等你确认</h3><p>{preview.entries.length} 个作品条目 · {preview.entries.reduce((sum, entry) => sum + entry.history.length, 0)} 次有日期的观看 · {preview.entries.filter(entry => entry.rating !== undefined).length} 项本人评分</p><ul>{preview.entries.slice(0, 6).map(entry => <li key={entry.id}>{entry.title}{entry.year ? `（${entry.year}）` : ""}</li>)}</ul><p>相同作品合并历史，保留旧感想；人生看板、阅读和事务继续保留。</p><div className="media-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存到影音"}</button><button type="button" className="button secondary" disabled={busy} onClick={() => { setPreview(null); setMessage(""); }}>放弃 Trakt 预览</button></div></div> : <><label className="field" htmlFor="trakt-client-id">Trakt Client ID<input id="trakt-client-id" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={128} value={clientId} disabled={busy} onChange={event => setClientId(event.target.value)} placeholder="应用的公开 Client ID"/></label><div className="media-actions"><button type="button" className="button primary" disabled={busy || !clientId.trim() || !redirectUri} onClick={() => void connect()}>{busy ? "正在连接并读取…" : "跳转 Trakt 授权"}</button>{busy && <button type="button" className="button secondary" onClick={cancel}>取消读取</button>}</div></>}
    <p className="media-muted">每次更新由你主动授权读取，不会修改 Trakt。访问令牌只用于本次读取，不写入浏览器存储或备份；刷新页面后需重新连接。临时授权信息仅留在当前标签页，完成回跳后清除。</p>
    <p className="media-muted">作品标题与类型按 Trakt 返回值保留，未提供的中文译名不自动猜测。官方提供的海报先缓存到当前浏览器再显示；图片读取失败时保留文字片卡，可主动重试。影音资料保存在当前浏览器，完整备份包含这些记录。资料来源：<a href="https://trakt.tv/" target="_blank" rel="noopener noreferrer">Trakt</a>。</p>
  </section>;
}
