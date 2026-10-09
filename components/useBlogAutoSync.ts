"use client";

import { useEffect, useRef, useState } from "react";
import { APP_BASE_PATH } from "@/lib/client";
import { normalizeBlogArchive, mergeBlogArchives, type BlogArchive } from "@/lib/blog";
import { readBlogCache, saveBlogCache } from "@/lib/blog-cache";

async function responseText(response: Response): Promise<string> {
  const maximum = 30_000_000;
  if (!response.body) throw new Error("博客同步资料为空。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new Error("博客同步资料过大。");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

export function useBlogAutoSync(ready: boolean) {
  const [archive, setArchive] = useState<BlogArchive | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const current = useRef<BlogArchive | undefined>(undefined);
  const flight = useRef<Promise<void> | null>(null);
  const mounted = useRef(false);
  const started = useRef(false);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);

  async function refresh() {
    if (!ready || !mounted.current) return;
    if (flight.current) return flight.current;
    const run = generation.current;
    const controller = new AbortController();
    abort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const alive = () => mounted.current && generation.current === run;
    const valid = () => alive() && !controller.signal.aborted;
    setBusy(true); setError("");
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        if (!current.current) {
          const cached = await readBlogCache().catch(() => null);
          if (!valid()) return;
          if (cached) { current.current = cached; setArchive(cached); }
        }
        const response = await fetch(`${APP_BASE_PATH}/blog-sync.json?t=${Date.now()}`, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
        if (response.status === 404) { if (valid()) setMessage(current.current ? "正在等待新的博客同步，已有内容保留。" : "博客首次同步正在准备，完成后会自动显示。请稍后刷新。"); return; }
        if (!response.ok) throw new Error("BlogUnavailable");
        const incoming = normalizeBlogArchive(JSON.parse(await responseText(response)));
        if (!incoming.entries.length) throw new Error("EmptyArchive");
        if (!valid()) return;
        const merged = current.current ? mergeBlogArchives(current.current, incoming) : incoming;
        current.current = merged; setArchive(merged);
        await saveBlogCache(merged).catch(() => { if (valid()) setError("博客内容已读取，但无法保存在此浏览器缓存中。你写的思考不受影响。"); });
        if (!valid()) return;
        setMessage("博客说说已自动检查，历史内容保留。");
      } catch {
        if (alive()) setError(current.current ? "暂时无法获取最新博客资料，仍可回看已缓存的内容。" : "暂时无法获取博客资料，请稍后刷新。你写的思考仍然保留。");
      } finally {
        clearTimeout(timeout);
        if (mounted.current && generation.current === run) setBusy(false);
        if (flight.current === promise) flight.current = null;
      }
    })();
    flight.current = promise;
    return promise;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Defer disposal across React's immediate development effect replay.
      queueMicrotask(() => { if (!mounted.current) { generation.current++; abort.current?.abort(); } });
    };
  }, []);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void refresh();
    // Navigation and background data changes do not restart the startup check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  function reset() {
    generation.current++; abort.current?.abort(); flight.current = null;
    current.current = undefined; setArchive(undefined); setBusy(false); setError(""); setMessage("");
  }
  return { archive, busy, error, message, refresh, reset };
}
