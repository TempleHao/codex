"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { IS_STATIC_PREVIEW } from "@/lib/client";
import { getWorkspaceLockState, lockWorkspace, resetWorkspaceLock, setupWorkspaceLock, subscribeWorkspaceLock, unlockWorkspace } from "@/lib/workspace-lock";
import "./workspace-gate.css";

type LockState = ReturnType<typeof getWorkspaceLockState>;

export default function WorkspaceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LockState | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);

  useEffect(() => {
    if (!IS_STATIC_PREVIEW) return;
    const refresh = () => {
      const next = getWorkspaceLockState();
      setState(next);
      if (next.unlocked) { setPassword(""); setConfirmation(""); setError(""); }
    };
    refresh();
    const unsubscribe = subscribeWorkspaceLock(refresh);
    const leaving = () => lockWorkspace();
    window.addEventListener("pagehide", leaving);
    return () => { unsubscribe(); window.removeEventListener("pagehide", leaving); };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current || !state) return;
    setError("");
    if (!state.configured && password !== confirmation) { setError("两次输入的口令不同，请再确认一下。"); return; }
    working.current = true; setBusy(true);
    try {
      if (state.configured) await unlockWorkspace(password);
      else await setupWorkspaceLock(password);
      setPassword(""); setConfirmation("");
      setState(getWorkspaceLockState());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法打开，请重试。"); }
    finally { working.current = false; setBusy(false); }
  }

  function reset() {
    if (working.current || !window.confirm("重置会删除这个浏览器中的全部人生看板、阅读、影音、思考、账单和事务记录。没有口令就无法恢复这些密文；已有导出备份可以在重新设置后恢复。确定重置本机空间吗？")) return;
    try { resetWorkspaceLock(); setPassword(""); setConfirmation(""); setError(""); setState(getWorkspaceLockState()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "重置失败，原记录仍保留。"); }
  }

  if (!IS_STATIC_PREVIEW) return children;
  if (!state) return <main className="workspace-gate workspace-gate-loading"><p>有序 · 正在打开你的空间…</p></main>;
  if (state.unlocked) return children;
  const settingUp = !state.configured;
  return <main className="workspace-gate">
    <div className="workspace-gate-brand"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M5 18C-1 6 13 2 21 3c0 9-3 18-13 17M4 22 17 8"/></svg><span>有序<small>人生工作台</small></span></div>
    <section className="workspace-gate-card" aria-labelledby="workspace-gate-heading">
      <p className="workspace-gate-kicker">给自己的生活，留一个安静的空间</p>
      <h1 id="workspace-gate-heading">{settingUp ? "设置本机口令" : "解锁有序"}</h1>
      <p className="workspace-gate-description">{settingUp ? "设置后，已有记录会在这个浏览器中加密保存。以后打开网页，先用口令解锁。" : "输入本机口令，回到你的生活记录。"}</p>
      <form onSubmit={event => void submit(event)} aria-busy={busy}>
        <label htmlFor="workspace-password">本机口令<input autoFocus id="workspace-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={settingUp ? "new-password" : "current-password"} minLength={settingUp ? 8 : undefined} maxLength={256} placeholder={settingUp ? "至少 8 个字符" : "输入你设置的口令"} disabled={busy} required/></label>
        {settingUp && <label htmlFor="workspace-confirmation">再次输入口令<input id="workspace-confirmation" type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" maxLength={256} disabled={busy} required/></label>}
        {(error || state.error) && <p className="workspace-gate-error" role="alert">{error || state.error}</p>}
        <button className="workspace-gate-submit" type="submit" disabled={busy || !password || (settingUp && !confirmation)}>{busy ? "正在打开…" : settingUp ? "设置口令并打开" : "解锁"}</button>
      </form>
      <p className="workspace-gate-note">{settingUp ? "请记好口令。应用不保存口令，也无法替你找回；进入后可导出备份。" : "这个浏览器保存着你的记录。口令和解锁密钥不会上传到 GitHub。"}</p>
      {!settingUp && <button className="workspace-gate-reset" type="button" disabled={busy} onClick={reset}>忘记口令</button>}
    </section>
    <p className="workspace-gate-scope">本机私人记录加密 · 公开博客与网页代码仍公开<br/>换设备时，通过导出备份移交你的记录。</p>
  </main>;
}
