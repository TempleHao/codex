"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { APP_BASE_PATH } from "@/lib/client";
import { formatReadingSeconds, type ReadingLibrary } from "@/lib/reading";
import { decryptReadingLibrary, generateReadingPassphrase, MAX_READING_ENVELOPE_BYTES } from "@/lib/reading-envelope";
import { readingSyncStatusSchema, type ReadingSyncStatus } from "@/lib/reading-sync-status";
import "./weread-sync.css";

export interface WeReadSyncProps {
  onImport: (library: ReadingLibrary) => Promise<void>;
}

const requestedRepository = process.env.NEXT_PUBLIC_GITHUB_REPOSITORY || "TempleHao/codex";
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(requestedRepository)
  && !requestedRepository.split("/").some(part => part === "." || part === "..")
  ? requestedRepository : "TempleHao/codex";
const githubUrl = `https://github.com/${repository}`;
const workflowUrl = `${githubUrl}/actions/workflows/pages.yml`;
const secretsUrl = `${githubUrl}/settings/secrets/actions`;

function displayDate(value?: string | null): string {
  if (!value) return "尚未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", hour12: false,
  }).format(date);
}

function statusExplanation(status: ReadingSyncStatus): string {
  if (status.state === "ready") return "同步已完成，可以读取现有资料。";
  if (status.state === "needs_setup") return "请先完成首次配置，再到 GitHub 启动同步。";
  const prefix = status.state === "preserved" ? "本次更新没有完成，上一份同步资料仍可读取。" : "本次更新没有完成，还没有可用的同步资料。";
  const explanations: Record<string, string> = {
    configuration_missing: "同步配置尚未填写完整。",
    invalid_configuration: "请检查 GitHub 中的同步配置。",
    authorization_failed: "请检查微信读书授权是否有效。",
    network_error: "读取服务暂时无法连接微信读书，稍后可以重新运行。",
    upgrade_required: "微信读书接口要求更新接入版本。",
    invalid_data: "本次取回的资料格式无法确认，已停止更新。",
    limit_exceeded: "本次资料超出同步容量，已停止更新。",
    notebook_limit_exceeded: "有笔记的书超过 1000 本同步上限，可以先在 GitHub 手动更新时取消勾选笔记，读取书架与统计。",
    note_limit_exceeded: "可导出的划线与想法超过 10000 条同步上限，可以先在 GitHub 手动更新时取消勾选笔记，读取书架与统计。",
    read_failed: "本次资料未能完整读取，稍后可以重新运行。",
    previous_decryption_failed: "请确认 GitHub 中的口令与上一份资料一致；修改口令需要重新设置同步。",
  };
  return `${prefix}${status.failureCode ? explanations[status.failureCode] ?? "请到 GitHub 查看同步结果。" : ""}`;
}

/** Bound a same-origin response before parsing; no response body enters errors. */
async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maximum) throw new Error("ResourceTooLarge");
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("ResourceTooLarge");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("ResourceTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function fetchResource(name: "weread-sync.json" | "weread-sync-status.json", signal: AbortSignal): Promise<Response> {
  return fetch(`${APP_BASE_PATH}/${name}`, {
    method: "GET", cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal,
  });
}

/** Passwords stay in uncontrolled inputs and transient refs, never workspace state. */
export default function WeReadSync({ onImport }: WeReadSyncProps) {
  const disclosureRef = useRef<HTMLDetailsElement>(null);
  const setupRef = useRef<HTMLDetailsElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const generatedRef = useRef<HTMLInputElement>(null);
  const transientPasswordRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef(0);
  const busyRef = useRef<"reading" | "saving" | "status" | null>(null);
  const [busy, setBusy] = useState<typeof busyRef.current>(null);
  const [status, setStatus] = useState<ReadingSyncStatus | null>(null);
  const [statusNote, setStatusNote] = useState("");
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ReadingLibrary | null>(null);
  const [saved, setSaved] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [setupMessage, setSetupMessage] = useState("");

  function clearPasswords() {
    transientPasswordRef.current = "";
    if (passwordRef.current) passwordRef.current.value = "";
    if (generatedRef.current) generatedRef.current.value = "";
  }

  useEffect(() => () => {
    runRef.current += 1;
    abortRef.current?.abort();
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    transientPasswordRef.current = "";
    if (passwordRef.current) passwordRef.current.value = "";
    if (generatedRef.current) generatedRef.current.value = "";
  }, []);

  function close() {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    clearPasswords();
    busyRef.current = null;
    setBusy(null);
    setDraft(null);
    setSaved(false);
    setError("");
    setGenerated(false);
    setSetupMessage("");
    if (setupRef.current) setupRef.current.open = false;
    if (disclosureRef.current) disclosureRef.current.open = false;
  }

  function begin(next: NonNullable<typeof busyRef.current>) {
    const run = ++runRef.current;
    abortRef.current?.abort();
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    const controller = new AbortController();
    abortRef.current = controller;
    // A stalled resource must not keep an unlock password around indefinitely.
    timeoutRef.current = next === "saving" ? null : setTimeout(() => controller.abort(), 30_000);
    busyRef.current = next;
    setBusy(next);
    setError("");
    return { run, controller };
  }

  function finish(run: number, controller: AbortController) {
    if (abortRef.current === controller) abortRef.current = null;
    if (run === runRef.current) {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      transientPasswordRef.current = "";
      if (passwordRef.current) passwordRef.current.value = "";
      busyRef.current = null;
      setBusy(null);
    }
  }

  async function loadStatus(signal: AbortSignal, run: number): Promise<void> {
    try {
      const response = await fetchResource("weread-sync-status.json", signal);
      if (response.status === 404) {
        if (run === runRef.current) { setStatus(null); setStatusNote("还没有同步状态，请先配置并运行一次同步。"); }
        return;
      }
      if (!response.ok) throw new Error("StatusUnavailable");
      const parsed = readingSyncStatusSchema.safeParse(JSON.parse(await readBoundedText(response, 10_000)));
      if (!parsed.success) throw new Error("InvalidStatus");
      if (run !== runRef.current) return;
      setStatus(parsed.data);
      setStatusNote("");
      if (parsed.data.state === "needs_setup" && setupRef.current) setupRef.current.open = true;
    } catch {
      if (run === runRef.current) setStatusNote("暂时无法查看同步状态，可以稍后重试，或到 GitHub 查看最近一次运行。");
    }
  }

  async function checkStatus() {
    if (busyRef.current) return;
    const { run, controller } = begin("status");
    try { await loadStatus(controller.signal, run); }
    finally { finish(run, controller); }
  }

  async function read(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const length = passwordRef.current?.value.length ?? 0;
    if (length < 16 || length > 1_024) {
      if (passwordRef.current) passwordRef.current.value = "";
      setError("请填写 16 到 1024 个字符的同步资料解锁口令。");
      return;
    }
    transientPasswordRef.current = passwordRef.current?.value ?? "";
    if (passwordRef.current) passwordRef.current.value = "";
    if (generatedRef.current) generatedRef.current.value = "";
    setGenerated(false);
    setSetupMessage("");
    const { run, controller } = begin("reading");
    setSaved(false);
    setMissing(false);
    setDraft(null);
    try {
      const [, response] = await Promise.all([
        loadStatus(controller.signal, run),
        fetchResource("weread-sync.json", controller.signal),
      ]);
      if (run !== runRef.current) return;
      if (response.status === 404) {
        setMissing(true);
        if (setupRef.current) setupRef.current.open = true;
        return;
      }
      if (!response.ok) {
        setError("暂时无法读取同步资料，请检查网络，或等 GitHub 更新完成后重试。现有阅读记录未更改。");
        return;
      }
      let encrypted: string;
      try { encrypted = await readBoundedText(response, MAX_READING_ENVELOPE_BYTES); }
      catch {
        if (run === runRef.current) setError("同步文件无法完整读取或超过容量，请重新运行同步。现有阅读记录未更改。");
        return;
      }
      if (run !== runRef.current) return;
      let decryption: Promise<ReadingLibrary>;
      try { decryption = decryptReadingLibrary(encrypted, transientPasswordRef.current); }
      finally { transientPasswordRef.current = ""; }
      try {
        const library = await decryption;
        if (run === runRef.current) setDraft(library);
      } catch {
        if (run === runRef.current) setError("解锁没有完成，请检查口令或同步文件。现有阅读记录未更改。");
      }
    } catch {
      if (run === runRef.current) setError("暂时无法读取同步资料，请检查网络，或等 GitHub 更新完成后重试。现有阅读记录未更改。");
    } finally { finish(run, controller); }
  }

  async function save() {
    if (!draft || busyRef.current) return;
    const { run, controller } = begin("saving");
    try {
      await onImport(draft);
      if (run === runRef.current) { setDraft(null); setSaved(true); }
    } catch {
      if (run === runRef.current) setError("保存没有完成，预览仍在这里，请重试。");
    } finally { finish(run, controller); }
  }

  function generate() {
    if (busyRef.current) return;
    setSetupMessage("");
    try {
      if (generatedRef.current) generatedRef.current.value = generateReadingPassphrase();
      setGenerated(true);
    } catch { setSetupMessage("当前浏览器无法生成安全口令，请使用 HTTPS 页面重试。"); }
  }

  async function copyGenerated() {
    if (!generatedRef.current?.value || busyRef.current) return;
    const run = runRef.current;
    try {
      await navigator.clipboard.writeText(generatedRef.current.value);
      if (run === runRef.current) setSetupMessage("口令已复制，请保存到密码管理器，再填入 GitHub Secret。");
    } catch {
      if (run === runRef.current) setSetupMessage("当前浏览器无法自动复制，请使用支持剪贴板的浏览器重试。");
    }
  }

  const ebooks = draft?.books.filter(book => book.kind === "ebook").length ?? 0;
  const audiobooks = draft?.books.filter(book => book.kind === "audiobook").length ?? 0;
  const articles = draft?.books.filter(book => book.kind === "article").length ?? 0;

  return <details className="weread-sync" ref={disclosureRef} onToggle={event => { if (!event.currentTarget.open) close(); }}>
    <summary>
      <span className="weread-sync-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5C8 3 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-1-10 1ZM12 5v15"/></svg></span>
      <span><strong>微信读书同步</strong><small>定时更新 · 先预览，再保存</small></span>
      <span className="weread-sync-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="weread-sync-body">
      <p className="weread-sync-intro">让书架、阅读时长与划线想法，在这里留下痕迹。</p>
      <p className="weread-sync-note">每天自动同步两次。想取最新记录，可以<a href={workflowUrl} target="_blank" rel="noopener noreferrer">在 GitHub 手动启动更新</a>；运行完成后，再回来读取。这里展示最近一次同步资料。</p>

      {saved ? <p className="weread-sync-success" role="status">阅读记录已保存。</p> : draft ? <section className="weread-sync-preview" aria-labelledby="weread-sync-preview-title">
        <h3 id="weread-sync-preview-title">已读取，等你确认</h3>
        <div className="weread-sync-counts"><span><strong>{draft.books.length}</strong> 阅读条目</span><span><strong>{draft.highlights.length}</strong> 划线与想法</span></div>
        <p>{ebooks} 本电子书 · {audiobooks} 本有声书{articles ? ` · ${articles} 个文章收藏入口` : ""}</p>
        {draft.books.length > 0 && <ul className="weread-sync-book-preview" aria-label="部分书架预览">
          {draft.books.slice(0, 5).map(book => <li key={book.id}><div><strong>{book.title}</strong>{book.author && <span>{book.author}</span>}</div><small>{{ wanted: "想读", reading: "在读", finished: "读完" }[book.status]}</small></li>)}
        </ul>}
        {draft.books.length > 5 && <p className="weread-sync-note">另有 {draft.books.length - 5} 个阅读条目，保存后可在书架查看。</p>}
        {draft.highlights.length > 0 && <details className="weread-sync-note-preview"><summary>预览部分划线与想法</summary>{draft.highlights.slice(0, 2).map(note => <article key={note.id}>
          <strong>{draft.books.find(book => book.id === note.bookId)?.title}</strong>
          {note.text.trim() && <p><span>划线</span>{note.text.slice(0, 500)}{note.text.length > 500 ? "…" : ""}</p>}
          {note.thought?.trim() && <p><span>想法</span>{note.thought.slice(0, 500)}{note.thought.length > 500 ? "…" : ""}</p>}
        </article>)}<p className="weread-sync-note">这里只展示前 {Math.min(draft.highlights.length, 2)} 条笔记片段，完整内容在确认保存后查看。</p></details>}
        {draft.stats && <p>累计阅读 {formatReadingSeconds(draft.stats.totalSeconds)}{draft.stats.readingDays !== undefined ? ` · ${draft.stats.readingDays} 个有效阅读日` : ""}。</p>}
        <p>资料同步时间：{displayDate(draft.syncedAt)}（北京时间）</p>
        <p className="weread-sync-note">解锁口令已清除。确认后合并到当前阅读记录，其他生活记录会继续保留。</p>
        <div className="weread-sync-actions"><button type="button" className="weread-sync-primary" onClick={() => void save()} disabled={busy !== null}>{busy === "saving" ? "正在保存…" : "保存到阅读"}</button><button type="button" onClick={() => { setDraft(null); setError(""); }} disabled={busy !== null}>放弃预览</button></div>
      </section> : <form onSubmit={event => void read(event)}>
        <label className="weread-sync-field" htmlFor="weread-sync-password">同步资料解锁口令<input ref={passwordRef} id="weread-sync-password" name="weread-sync-temporary-password" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={1_024} placeholder="填写首次配置时保存的口令" disabled={busy !== null} aria-describedby="weread-sync-password-note"/></label>
        <p id="weread-sync-password-note" className="weread-sync-note">使用首次配置时的同步口令，至少 16 个字符。口令只用于本次解锁，读取结束或关闭时清除。</p>
        <div className="weread-sync-actions"><button type="submit" className="weread-sync-primary" disabled={busy !== null}>{busy === "reading" ? "正在读取并解锁…" : "读取同步资料"}</button><button type="button" onClick={close} disabled={busy === "saving"}>关闭同步</button></div>
      </form>}

      {missing && <div className="weread-sync-missing" role="status"><strong>还没有同步资料</strong><p>完成下方首次配置，并在 GitHub 运行一次更新后，再回来读取。</p></div>}
      {error && <p className="weread-sync-error" role="alert">{error}</p>}
      <div className="weread-sync-status">
        <button type="button" className="weread-sync-text-button" onClick={() => void checkStatus()} disabled={busy !== null}>{busy === "status" ? "正在查看…" : "查看同步状态"}</button>
        {status && <p>{statusExplanation(status)}<span>最近检查：{displayDate(status.updatedAt)}（北京时间）</span></p>}
        {statusNote && <p role="status">{statusNote}</p>}
      </div>
      {(draft || saved) && <div className="weread-sync-actions"><button type="button" onClick={close} disabled={busy === "saving"}>关闭同步</button></div>}

      <details className="weread-sync-setup" ref={setupRef} onToggle={event => {
        if (!event.currentTarget.open) {
          if (generatedRef.current) generatedRef.current.value = "";
          setGenerated(false);
          setSetupMessage("");
        }
      }}>
        <summary>首次配置同步</summary>
        <p>只需配置一次，日常回来填写同步口令即可。</p>
        <ol>
          <li>打开<a href={secretsUrl} target="_blank" rel="noopener noreferrer">GitHub 的 Actions Secrets 设置</a>，点击 <strong>New repository secret</strong>。</li>
          <li>添加 <code>WEREAD_API_KEY</code>，填写微信读书官方 API Key。</li>
          <li>添加 <code>WEREAD_SYNC_PASSPHRASE</code>，填写至少 16 个字符的同步口令。它也是本页的解锁口令，请先保存到密码管理器。</li>
          <li>打开<a href={workflowUrl} target="_blank" rel="noopener noreferrer">同步更新页面</a>，点击 <strong>Run workflow</strong>。等待运行成功，再回到这里点击“读取同步资料”。</li>
        </ol>
        <div className="weread-sync-actions"><button type="button" onClick={generate} disabled={busy !== null}>生成随机口令</button></div>
        <div className="weread-sync-generated" hidden={!generated}>
          <label className="weread-sync-field" htmlFor="weread-sync-generated-password">本次生成的同步口令<input ref={generatedRef} id="weread-sync-generated-password" type="password" readOnly autoComplete="off" aria-describedby="weread-sync-generated-note"/></label>
          <p id="weread-sync-generated-note">关闭配置或离开本页后清除，请先复制并妥善保存。</p>
          <button type="button" onClick={() => void copyGenerated()} disabled={busy !== null}>复制同步口令</button>
        </div>
        {setupMessage && <p className="weread-sync-setup-message" role="status">{setupMessage}</p>}
        <p className="weread-sync-note">API Key 只填入 GitHub Secret，不需要填写在网页。同步文件经过口令加密；更改口令前，请先阅读<a href={`${githubUrl}/blob/main/docs/GITHUB_READING_SYNC.md`} target="_blank" rel="noopener noreferrer">同步说明</a>，以免丢失云端保留的历史资料。</p>
      </details>
    </div>
  </details>;
}
