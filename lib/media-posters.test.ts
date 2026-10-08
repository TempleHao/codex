import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaPosterLoader, MAX_POSTER_BYTES, type MediaPosterCache } from "./media-posters";

const url = "https://walter-r2.trakt.tv/images/movies/000/001/posters/thumb/a.jpg.webp";
const image = () => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "image/webp" } });
function memoryCache(): MediaPosterCache {
  const entries = new Map<string, Blob>();
  return {
    get: vi.fn(async key => entries.get(key)),
    set: vi.fn(async (key, blob) => { entries.set(key, blob); }),
    delete: vi.fn(async key => { entries.delete(key); }),
    clear: vi.fn(async () => { entries.clear(); }),
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("public browser poster cache", () => {
  it("rejects unsafe addresses before reading storage or fetching", async () => {
    const cache = memoryCache();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache });
    for (const invalid of ["https://evil.example/a.webp", url.replace("https:", "http:"), `${url}?token=secret`, url.replace(".webp", ".jpg")]) {
      await expect(loader.load(invalid)).rejects.toThrow("地址");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("deduplicates downloads, uses a native fetch receiver and omits credentials/referrers", async () => {
    const cache = memoryCache();
    const fetch = vi.fn(function (this: unknown, _input: unknown, options: RequestInit) {
      expect(this).toBe(globalThis);
      expect(options).toMatchObject({ mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(image());
    });
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache });
    const [one, two] = await Promise.all([loader.load(url), loader.load(url)]);
    expect(one).toBe(two);
    expect(one.type).toBe("image/webp");
    expect(await loader.load(url)).toBe(one);
    // A fresh loader proves persistent cache hits avoid the CDN as well.
    expect(await createMediaPosterLoader({ cache }).load(url)).toBe(one);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still displays a downloaded blob when browser storage fails", async () => {
    const cache = memoryCache();
    vi.mocked(cache.get).mockRejectedValue(new Error("Storage blocked"));
    vi.mocked(cache.set).mockRejectedValue(new Error("Quota exceeded"));
    vi.stubGlobal("fetch", vi.fn(async () => image()));
    const loader = createMediaPosterLoader({ cache });
    expect((await loader.load(url)).size).toBe(4);
    expect((await loader.load(url)).size).toBe(4);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("works without IndexedDB in the runtime", async () => {
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("fetch", vi.fn(async () => image()));
    const loader = createMediaPosterLoader();
    expect((await loader.load(url)).type).toBe("image/webp");
    await loader.load(url);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects the wrong MIME type, excessive announced size and excessive streamed size", async () => {
    const cache = memoryCache();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("html", { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response("x", { headers: { "content-type": "image/webp", "content-length": String(MAX_POSTER_BYTES + 1) } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_POSTER_BYTES + 1), { headers: { "content-type": "image/webp" } }))
      .mockResolvedValueOnce(new Response(null, { headers: { "content-type": "image/webp" } }));
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache });
    await expect(loader.load(url)).rejects.toThrow("格式");
    await expect(loader.load(url)).rejects.toThrow("过大");
    await expect(loader.load(url)).rejects.toThrow("过大");
    await expect(loader.load(url)).rejects.toThrow("为空");
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("allows failed requests to be retried and successful entries to be invalidated", async () => {
    const cache = memoryCache();
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("CORS failure")).mockImplementation(async () => image());
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache });
    await expect(loader.load(url)).rejects.toThrow("CORS failure");
    await loader.invalidate(url);
    await loader.load(url);
    await loader.invalidate(url);
    await loader.load(url);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("limits simultaneous downloads to three", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      active++;
      maximum = Math.max(maximum, active);
      return new Promise<Response>(resolve => { releases.push(() => { active--; resolve(image()); }); });
    }));
    const loader = createMediaPosterLoader({ cache: memoryCache() });
    const loads = Array.from({ length: 7 }, (_, index) => loader.load(url.replace("a.jpg.webp", `${index}.jpg.webp`)));
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (let index = 0; index < loads.length; index++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));
      releases[index]();
    }
    await Promise.all(loads);
    expect(maximum).toBe(3);
  });

  it("aborts slow fetches on timeout and permits a later retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("Timeout")));
    }));
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache: memoryCache(), timeoutMs: 100 });
    const pending = loader.load(url);
    const failure = expect(pending).rejects.toThrow("Timeout");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    fetch.mockImplementationOnce(async () => image());
    expect((await loader.load(url)).type).toBe("image/webp");
  });

  it("aborts active downloads, rejects queued loads and does not repopulate a cleared cache", async () => {
    const cache = memoryCache();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signals.push(options.signal!);
      options.signal!.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache });
    const loads = Array.from({ length: 8 }, (_, index) => loader.load(url.replace("a.jpg.webp", `${index}.jpg.webp`)));
    const settled = Promise.allSettled(loads);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const cleared = loader.clear();
    await expect(loader.load(url)).rejects.toThrow("正在清空");
    await cleared;
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.get).toHaveBeenCalledTimes(3);
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.clear).toHaveBeenCalledTimes(1);
    fetch.mockImplementationOnce(async () => image());
    await loader.load(url);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects an old cache lookup resolved during clearing before it can download", async () => {
    const cache = memoryCache();
    let release!: (blob: Blob | undefined) => void;
    vi.mocked(cache.get).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const fetch = vi.fn(async () => image());
    vi.stubGlobal("fetch", fetch);
    const loader = createMediaPosterLoader({ cache });
    const pending = loader.load(url);
    const rejected = expect(pending).rejects.toThrow("已取消");
    const cleared = loader.clear();
    release(undefined);
    await rejected;
    await cleared;
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.clear).toHaveBeenCalledTimes(1);
  });
});
