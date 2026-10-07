"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatReadingSeconds, type ReadingLibrary } from "@/lib/reading";
import { WeReadClient, WeReadError } from "@/lib/weread";
import { fetchWeReadLibrary, WeReadSyncError } from "@/lib/weread-sync";
import "./weread-connect.css";

export interface WeReadConnectProps {
  onImport: (library: ReadingLibrary) => Promise<void>;
}

function connectionError(error: unknown): string {
  if (error instanceof WeReadSyncError) return error.message;
  if (error instanceof WeReadError) {
    if (error.code === "NetworkError") return "暂时无法连接微信读书，可能是网络或浏览器跨域限制（CORS）。可以稍后重试，也可以使用本页的 JSON 导入。";
    return error.message;
  }
  return "本次读取没有完成，未保存阅读数据。请稍后重试或使用本页的 JSON 导入。";
}

/** Authentication stays in an uncontrolled password input and a short-lived official client. */
export default function WeReadConnect({ onImport }: WeReadConnectProps) {
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<WeReadClient | null>(null);
  const runRef = useRef(0);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy] = useState<"reading" | "saving" | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ReadingLibrary | null>(null);
  const [draftIncludesNotes, setDraftIncludesNotes] = useState(true);
  const [saved, setSaved] = useState(false);

  function clearConnection() {
    if (keyRef.current) keyRef.current.value = "";
    clientRef.current?.disconnect();
    clientRef.current = null;
  }

  useEffect(() => () => {
    runRef.current += 1;
    if (keyRef.current) keyRef.current.value = "";
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  function close() {
    runRef.current += 1;
    clearConnection();
    setBusy(null);
    setProgress("");
    setError("");
    setDraft(null);
    setSaved(false);
    if (disclosureRef.current) disclosureRef.current.open = false;
  }

  async function read(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const token = keyRef.current?.value.trim() ?? "";
    if (!token) { setError("请先填写微信读书 API Key。"); return; }
    const run = ++runRef.current;
    setError("");
    setSaved(false);
    setDraft(null);
    setBusy("reading");
    let client: WeReadClient | null = null;
    try {
      client = new WeReadClient({ token });
      clientRef.current = client;
      if (keyRef.current) keyRef.current.value = "";
      const library = await fetchWeReadLibrary(client, { includeNotes, onProgress: update => { if (run === runRef.current) setProgress(update.message); } });
      if (run !== runRef.current) return;
      setDraftIncludesNotes(includeNotes);
      setDraft(library);
      setProgress("");
    } catch (caught) {
      if (run === runRef.current) { setDraft(null); setError(connectionError(caught)); setProgress(""); }
    } finally {
      client?.disconnect();
      if (clientRef.current === client) clientRef.current = null;
      if (run === runRef.current) { if (keyRef.current) keyRef.current.value = ""; setBusy(null); }
    }
  }

  async function save() {
    if (!draft || busy) return;
    const run = runRef.current;
    setBusy("saving");
    setError("");
    try {
      await onImport(draft);
      if (run === runRef.current) { setDraft(null); setSaved(true); }
    } catch {
      if (run === runRef.current) setError("保存没有完成，预览仍在这里，请重试。");
    } finally { if (run === runRef.current) setBusy(null); }
  }

  const ebooks = draft?.books.filter(book => book.kind === "ebook").length ?? 0;
  const audiobooks = draft?.books.filter(book => book.kind === "audiobook").length ?? 0;
  const articles = draft?.books.filter(book => book.kind === "article").length ?? 0;
  return <details className="weread-connect" ref={disclosureRef} onToggle={event => { if (!event.currentTarget.open) close(); }}>
    <summary><span className="weread-connect-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5C8 3 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-1-10 1ZM12 5v15"/></svg></span><span><strong>从微信读书带来阅读记录</strong><small>临时连接 · 先预览，再保存</small></span><span className="weread-connect-chevron" aria-hidden="true">⌄</span></summary>
    <div className="weread-connect-body">
      <p className="weread-connect-intro">取回书架、阅读统计与划线想法，让读过的书在这里留下痕迹。</p>
      <p className="weread-connect-note">刷新后需重新连接；此功能正在验证浏览器兼容性。</p>
      {saved ? <p className="weread-connect-success" role="status">阅读记录已保存。</p> : draft ? <section className="weread-connect-preview" aria-labelledby="weread-preview-title">
        <h3 id="weread-preview-title">已取回，等你确认</h3>
        <div className="weread-connect-counts"><span><strong>{draft.books.length}</strong> 阅读条目</span><span><strong>{draft.highlights.length}</strong> 划线与想法</span></div>
        <p>{ebooks} 本电子书 · {audiobooks} 本有声书{articles ? ` · ${articles} 个文章收藏入口` : ""}</p>
        {draft.stats && <p>累计阅读 {formatReadingSeconds(draft.stats.totalSeconds)}{draft.stats.readingDays !== undefined ? ` · ${draft.stats.readingDays} 个有效阅读日` : ""}；今年获取 {draft.stats.dailySeconds.length} 天的每日记录。</p>}
        <p className="weread-connect-note">{draftIncludesNotes ? "笔记内容包含划线与个人想法；接口暂不提供书签内容。" : "此次未获取笔记。"}取回的数据尚未保存，授权已清除。</p>
        <div className="weread-connect-actions"><button type="button" className="weread-connect-save" onClick={() => void save()} disabled={busy !== null}>{busy === "saving" ? "正在保存…" : "保存到阅读"}</button><button type="button" onClick={() => { setDraft(null); setError(""); }} disabled={busy !== null}>放弃预览</button></div>
      </section> : <form onSubmit={event => void read(event)}>
        <label className="weread-connect-field" htmlFor="weread-api-key">微信读书 API Key<input ref={keyRef} id="weread-api-key" name="weread-temporary-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="粘贴官方 API Key" disabled={busy !== null} aria-describedby="weread-key-note"/></label>
        <p id="weread-key-note" className="weread-connect-note">在微信读书官方渠道获取 API Key。授权仅用于这次读取，只发送到微信读书官方接口，结束或关闭时清除。</p>
        <label className="weread-connect-checkbox"><input type="checkbox" checked={includeNotes} onChange={event => setIncludeNotes(event.target.checked)} disabled={busy !== null}/><span>同时取回划线与想法</span></label>
        <div className="weread-connect-actions"><button type="submit" className="weread-connect-save" disabled={busy !== null}>{busy === "reading" ? "正在读取…" : "读取并预览"}</button><button type="button" onClick={close}>关闭连接</button></div>
      </form>}
      {progress && <p className="weread-connect-progress" role="status" aria-live="polite">{progress}</p>}
      {error && <p className="weread-connect-error" role="alert">{error}</p>}
      <details className="weread-connect-help"><summary>连接不成功时</summary><p>网络或浏览器跨域限制（CORS）可能影响临时连接。浏览器直连兼容性尚未验证，无法连接时，请使用本页的 JSON 导入入口。</p><p>一次最多获取 80 本有笔记的书、10000 条划线与想法；超过时会停止，你可以先取消勾选笔记，仅获取书架与统计。</p></details>
    </div>
  </details>;
}
