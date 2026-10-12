"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { IS_STATIC_PREVIEW } from "@/lib/client";
import { dismissWorkspaceNotice, getWorkspaceLockState, resetWorkspaceLock, restoreTrustedWorkspace, setupWorkspaceLock, subscribeWorkspaceLock, suspendWorkspace, unlockWorkspace } from "@/lib/workspace-lock";
import "./workspace-gate.css";

type LockState = ReturnType<typeof getWorkspaceLockState>;
const DEVICE_CHOICE = "life-workbench-device-choice-v1";

export default function WorkspaceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LockState | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(true);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const working = useRef(false);

  useEffect(() => {
    if (!IS_STATIC_PREVIEW) return;
    try { setRemember(localStorage.getItem(DEVICE_CHOICE) !== "shared"); } catch { setRemember(false); }
    let alive = true;
    let opening = false;
    const refresh = () => {
      const next = getWorkspaceLockState();
      setState(next);
      if (next.unlocked) { setPassword(""); setConfirmation(""); setError(""); }
    };
    const unsubscribe = subscribeWorkspaceLock(refresh);
    const open = async () => {
      if (opening || working.current) return;
      if (getWorkspaceLockState().unlocked) { refresh(); return; }
      opening = true;
      if (alive) setProbing(true);
      await restoreTrustedWorkspace();
      if (alive) { refresh(); setProbing(false); }
      opening = false;
    };
    const resume = () => { void open(); };
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    const leaving = () => suspendWorkspace();
    void open();
    window.addEventListener("pagehide", leaving);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visible);
    const expiryCheck = window.setInterval(refresh, 60_000);
    return () => {
      alive = false; unsubscribe(); window.clearInterval(expiryCheck);
      window.removeEventListener("pagehide", leaving); window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current || !state) return;
    setError("");
    if (!state.configured && password !== confirmation) { setError("两次输入的口令不同，请再确认一下。"); return; }
    working.current = true; setBusy(true);
    try {
      if (state.configured) await unlockWorkspace(password, { rememberDevice: remember });
      else await setupWorkspaceLock(password, { rememberDevice: remember });
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
  if (!state || probing) return <main className="workspace-gate workspace-gate-loading"><p>有序 · 正在打开你的空间…</p></main>;
  if (state.unlocked) return <>{state.notice && <aside className="workspace-trust-notice" role="status"><p>{state.notice}</p><button type="button" aria-label="关闭设备记忆提示" onClick={dismissWorkspaceNotice}>×</button></aside>}{children}</>;
  const settingUp = !state.configured;
  return <main className="workspace-gate">
    <div className="workspace-gate-brand"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M5 18C-1 6 13 2 21 3c0 9-3 18-13 17M4 22 17 8"/></svg><span>有序<small>人生工作台</small></span></div>
    <section className="workspace-gate-card" aria-labelledby="workspace-gate-heading">
      <p className="workspace-gate-kicker">给自己的生活，留一个安静的空间</p>
      <h1 id="workspace-gate-heading">{settingUp ? "设置本机口令" : "解锁有序"}</h1>
      <p className="workspace-gate-description">{settingUp ? "设置口令，让已有记录在这个浏览器中加密保存。个人设备可以记住解锁状态，日常打开更顺手。" : "输入本机口令，回到你的生活记录。验证后可以记住这台设备。"}</p>
      <form onSubmit={event => void submit(event)} aria-busy={busy}>
        <label htmlFor="workspace-password">本机口令<input autoFocus id="workspace-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={settingUp ? "new-password" : "current-password"} minLength={settingUp ? 8 : undefined} maxLength={256} placeholder={settingUp ? "至少 8 个字符" : "输入你设置的口令"} disabled={busy} required/></label>
        {settingUp && <label htmlFor="workspace-confirmation">再次输入口令<input id="workspace-confirmation" type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" maxLength={256} disabled={busy} required/></label>}
        <label className="workspace-remember" htmlFor="workspace-remember"><input id="workspace-remember" type="checkbox" checked={remember} onChange={event => {
          const selected = event.target.checked; setRemember(selected);
          try { localStorage.setItem(DEVICE_CHOICE, selected ? "personal" : "shared"); } catch { /* The current choice still applies to this unlock. */ }
        }} disabled={busy}/><span>记住这台设备 30 天<small>期间此浏览器可直接进入。共享设备请取消勾选。</small></span></label>
        {(error || state.error) && <p className="workspace-gate-error" role="alert">{error || state.error}</p>}
        <button className="workspace-gate-submit" type="submit" disabled={busy || !password || (settingUp && !confirmation)}>{busy ? "正在打开…" : settingUp ? "设置口令并打开" : "解锁"}</button>
      </form>
      <p className="workspace-gate-note">记住设备只在本机保存解锁密钥，不保存口令。到期需重新验证，点顶部锁定可立即取消记忆。请记好口令并保留备份。</p>
      {!settingUp && <button className="workspace-gate-reset" type="button" disabled={busy} onClick={reset}>忘记口令</button>}
    </section>
    <p className="workspace-gate-scope">本机私人记录加密 · 公开博客与网页代码仍公开<br/>换设备时，通过导出备份移交你的记录。</p>
  </main>;
}
