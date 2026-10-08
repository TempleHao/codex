"use client";

import { useState } from "react";
import type { TraktController } from "./useTraktAutoSync";

export default function TraktSync({ connection }: { connection: TraktController }) {
  const { clientId, setClientId, redirectUri, origin, busy, connected, lastSynced, error, message, preview, connect, cancel, save } = connection;
  const [copyNote, setCopyNote] = useState("");
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopyNote("已复制。"); }
    catch { setCopyNote("当前浏览器无法自动复制，请选择上方文字复制。"); }
  }
  return <section className="media-card trakt-sync" aria-labelledby="trakt-sync-heading">
    <p className="eyebrow">TRAKT</p><h2 id="trakt-sync-heading">连接自己的影音足迹</h2>
    <p>首次跳转到 Trakt 授权，预览并保存后，在此浏览器记住连接。之后每次打开人生应用，会自动更新观影历史、想看片单和本人评分。</p>
    {connected && <div className="trakt-connected"><p>已连接 · 每次打开网页自动更新{lastSynced ? ` · 最近更新 ${new Date(lastSynced).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : ""}</p><div className="media-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void connection.refresh()}>立即更新</button><button type="button" className="text-button" onClick={() => void connection.disconnect().catch(() => {})}>断开 Trakt 连接</button></div></div>}
    <details className="trakt-config"><summary>首次配置 Trakt 应用</summary><ol><li>在 <a href="https://developer.trakt.tv/apps" target="_blank" rel="noopener noreferrer">Trakt 开发者页面</a>创建自己的应用，按官方要求连接已验证的 GitHub 账户。</li><li>回调地址（Redirect URI）：<code>{redirectUri || "页面载入后显示"}</code><button type="button" className="text-button" onClick={() => void copy(redirectUri)}>复制回调地址</button></li><li>JavaScript / CORS 来源只填域名来源，不带仓库路径：<code>{origin || "页面载入后显示"}</code><button type="button" className="text-button" onClick={() => void copy(origin)}>复制 CORS 来源</button></li><li>把应用的公开 Client ID 填到下方，然后跳转授权。此网页使用 PKCE，不需要 Client Secret。</li></ol>{copyNote && <p role="status">{copyNote}</p>}</details>
    {error && <p className="media-error" role="alert">{error}</p>}{message && <p className="media-message" role="status">{message}</p>}
    {preview ? <div className="trakt-preview"><h3>已读取，等你确认</h3><p>{preview.entries.length} 个作品条目 · {preview.entries.reduce((sum, entry) => sum + entry.history.length, 0)} 次有日期的观看 · {preview.entries.filter(entry => entry.rating !== undefined).length} 项本人评分</p><ul>{preview.entries.slice(0, 6).map(entry => <li key={entry.id}>{entry.title}{entry.year ? `（${entry.year}）` : ""}</li>)}</ul><p>相同作品合并历史，保留旧感想；人生看板、阅读和事务继续保留。</p><div className="media-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存到影音"}</button><button type="button" className="button secondary" disabled={busy} onClick={() => connection.discard()}>放弃 Trakt 预览</button></div></div> : <><label className="field" htmlFor="trakt-client-id">Trakt Client ID<input id="trakt-client-id" autoCapitalize="none" autoComplete="off" spellCheck={false} maxLength={128} value={clientId} disabled={busy} onChange={event => setClientId(event.target.value)} placeholder="应用的公开 Client ID"/></label><div className="media-actions"><button type="button" className="button primary" disabled={busy || !clientId.trim() || !redirectUri} onClick={() => void connect()}>{busy ? "正在连接并读取…" : "跳转 Trakt 授权"}</button>{busy && <button type="button" className="button secondary" onClick={cancel}>取消读取</button>}</div></>}
    <p className="media-muted">保存后，Trakt 连接会单独留在本机浏览器，用于打开网页时自动读取和续期；不会修改 Trakt 上的观看记录，也不会把连接信息放进备份或 GitHub。可随时断开连接。初次授权或授权被撤销时，才需要再次跳转授权。</p>
    <p className="media-muted">作品标题与类型按 Trakt 返回值保留，未提供的中文译名不自动猜测。官方提供的海报先缓存到当前浏览器再显示；图片读取失败时保留文字片卡，可主动重试。影音资料保存在当前浏览器，完整备份包含这些记录。资料来源：<a href="https://trakt.tv/" target="_blank" rel="noopener noreferrer">Trakt</a>。</p>
  </section>;
}
