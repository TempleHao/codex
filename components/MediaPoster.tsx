"use client";

import { useEffect, useRef, useState } from "react";
import { loadMediaPoster } from "../lib/media-posters";
import { loadPosterWorkerSource } from "../lib/poster-worker-client";
import type { MediaKind } from "../lib/media";

export function MediaPoster({ url, title, kind }: { url?: string; title: string; kind: MediaKind }) {
  const element = useRef<HTMLSpanElement>(null);
  const [nearby, setNearby] = useState(false);
  const [corsFailedUrl, setCorsFailedUrl] = useState<string>();
  const [image, setImage] = useState<{ url: string; src: string }>();
  const [failedUrl, setFailedUrl] = useState<string>();
  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === "undefined") { setNearby(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "300px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void loadMediaPoster(url).then(blob => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ url, src: objectUrl });
      setFailedUrl(undefined);
    }).catch(() => { if (!disposed) setCorsFailedUrl(url); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  useEffect(() => {
    if (!url || corsFailedUrl !== url || !nearby) return;
    let disposed = false;
    void loadPosterWorkerSource(url).then(src => {
      if (!disposed) { setImage({ url, src }); setFailedUrl(undefined); }
    }).catch(() => { if (!disposed) setFailedUrl(url); });
    return () => { disposed = true; };
  }, [url, corsFailedUrl, nearby]);
  const src = image && image.url === url ? image.src : undefined;
  const failed = Boolean(url && failedUrl === url);
  return (
    <span ref={element} className={`media-title-art media-art-${kind}`} data-poster-failed={failed ? url : undefined}>
      {src && !failed ? <img src={src} alt={`${title}海报`} onError={() => setFailedUrl(url)} /> : <>
        <span>{Array.from(title.trim())[0] ?? "影"}</span>
        <small>{failed ? "海报加载失败" : kind === "movie" ? "电影" : kind === "show" ? "剧集" : "单集"}</small>
      </>}
    </span>
  );
}
