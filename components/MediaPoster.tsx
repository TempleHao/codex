"use client";

import { useEffect, useState } from "react";
import { loadMediaPoster } from "../lib/media-posters";
import type { MediaKind } from "../lib/media";

export function MediaPoster({ url, title, kind }: { url?: string; title: string; kind: MediaKind }) {
  const [image, setImage] = useState<{ url: string; src: string }>();
  const [failedUrl, setFailedUrl] = useState<string>();
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void loadMediaPoster(url).then(blob => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setImage({ url, src: objectUrl });
      setFailedUrl(undefined);
    }).catch(() => { if (!disposed) setFailedUrl(url); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  const src = image && image.url === url ? image.src : undefined;
  const failed = Boolean(url && failedUrl === url);
  return (
    <span className={`media-title-art media-art-${kind}`} data-poster-failed={failed ? url : undefined}>
      {src && !failed ? <img src={src} alt={`${title}海报`} onError={() => setFailedUrl(url)} /> : <>
        <span>{Array.from(title.trim())[0] ?? "影"}</span>
        <small>{failed ? "海报加载失败" : kind === "movie" ? "电影" : kind === "show" ? "剧集" : "单集"}</small>
      </>}
    </span>
  );
}
