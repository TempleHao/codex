import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserStore, BROWSER_STORAGE_KEY } from "./client";
import type { WorkspaceData } from "./types";

class FakeStorage implements Storage {
  private entries = new Map<string, string>();
  writes = 0;
  failRead = false;
  failWrite: "quota" | "security" | null = null;
  failRemove = false;
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
  getItem(key: string) {
    if (this.failRead) throw new DOMException("blocked", "SecurityError");
    return this.entries.get(key) ?? null;
  }
  removeItem(key: string) {
    if (this.failRemove) throw new DOMException("blocked", "SecurityError");
    this.entries.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw new DOMException("blocked", this.failWrite === "quota" ? "QuotaExceededError" : "SecurityError");
    this.entries.set(key, String(value));
    this.writes += 1;
  }
}

function batch(titles = ["预约洗牙"], sourceText = "聊天整理的待办") {
  return { batchId: crypto.randomUUID(), sourceText, tasks: titles.map(title => ({ title })) };
}

function jsonOptions(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("浏览器独立存储", () => {
  it("初次读取不初始化数据，批次重复不新增，改变内容不写入", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    expect(store.snapshot()).toEqual({ tasks: [], sources: [] });
    expect(storage.length).toBe(0);
    const input = batch(["买菜", "整理书桌"]);
    const saved = store.addBatch(input);
    const writes = storage.writes;
    expect(store.addBatch(input)).toEqual(saved);
    expect(storage.writes).toBe(writes);
    const original = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.addBatch({ ...input, sourceText: "变更后的原文" })).toThrow("内容发生了变化");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(original);
    expect(new BrowserStore(storage).snapshot()).toEqual(saved);
  });

  it("每次操作重新读取数据，另一个标签页的新增不会被覆盖", () => {
    const storage = new FakeStorage();
    const firstTab = new BrowserStore(storage);
    const secondTab = new BrowserStore(storage);
    firstTab.snapshot();
    secondTab.addBatch(batch(["买菜"]));
    firstTab.addBatch(batch(["预约洗牙"]));
    expect(secondTab.snapshot().tasks).toHaveLength(2);
  });

  it("更新完成与重新打开保持 ID、原文和其他字段，重复完成保持完成时间", () => {
    const store = new BrowserStore(new FakeStorage());
    const [task] = store.addBatch(batch()).tasks;
    const done = store.update(task.id, { status: "done" })!;
    expect(done.completedAt).not.toBeNull();
    expect(store.update(task.id, { status: "done" })?.completedAt).toBe(done.completedAt);
    const edited = store.update(task.id, { title: "预约口腔检查", dueDate: "2026-10-09" })!;
    expect(edited.id).toBe(task.id);
    expect(edited.sourceId).toBe(task.sourceId);
    expect(edited.status).toBe("done");
    expect(edited.notes).toBe(task.notes);
    const reopened = store.update(task.id, { status: "todo" })!;
    expect(reopened.completedAt).toBeNull();
    expect(reopened.dueDate).toBe("2026-10-09");
    expect(() => store.update(task.id, { id: crypto.randomUUID() })).toThrow("不支持的字段");
  });

  it("删除最后一个相关待办时删除原文及批次缓存，不保留已删内容", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const input = batch(["买菜专属待办", "整理书桌专属待办"], "这是一份即将删除的专属原文");
    const { tasks } = store.addBatch(input);
    expect(store.remove(tasks[0].id)).toBe(true);
    expect(store.snapshot().sources).toHaveLength(1);
    // Retry protection still applies while part of the batch remains.
    expect(store.addBatch(input).tasks).toHaveLength(1);
    expect(store.remove(tasks[1].id)).toBe(true);
    expect(store.snapshot()).toEqual({ tasks: [], sources: [] });
    const raw = storage.getItem(BROWSER_STORAGE_KEY)!;
    expect(raw).not.toContain(input.sourceText);
    expect(raw).not.toContain(input.tasks[0].title);
    expect(raw).not.toContain(input.tasks[1].title);
    expect(raw).not.toContain(input.batchId);
    expect(store.remove(tasks[1].id)).toBe(false);
    // Once the entire batch is deliberately deleted, a fresh import can create it again.
    expect(store.addBatch(input).tasks).toHaveLength(2);
  });

  it("导出与恢复保留完整数据及 ID，重复恢复幂等且可增量合并", () => {
    const first = new BrowserStore(new FakeStorage());
    first.addBatch(batch(["买菜"]));
    const backup = first.exportBackup();
    expect(backup.format).toBe("life-workbench-backup");
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toMatch(/T.*Z$/);
    expect(Object.keys(backup).sort()).toEqual(["exportedAt", "format", "sources", "tasks", "version"]);
    const second = new BrowserStore(new FakeStorage());
    second.addBatch(batch(["洗衣服"]));
    const merged = second.restore(backup);
    expect(merged.tasks).toHaveLength(2);
    expect(merged.tasks.some(task => task.id === backup.tasks[0].id)).toBe(true);
    expect(second.restore(backup)).toEqual(merged);
  });

  it("恢复待办冲突时，不写入备份中先处理的新原文或新待办", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    store.addBatch(batch(["原有事项"]));
    const original = store.exportBackup();
    const another = new BrowserStore(new FakeStorage());
    another.addBatch(batch(["新的事项"]));
    const additional = another.exportBackup();
    const mixed = {
      ...original,
      sources: [...additional.sources, ...original.sources],
      tasks: [...additional.tasks, { ...original.tasks[0], title: "发生冲突的标题" }],
    };
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.restore(mixed)).toThrow("待办冲突");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.snapshot().tasks).toEqual(original.tasks);
  });

  it("原文冲突、重复 ID 或关联原文缺失时拒绝整份恢复", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    store.addBatch(batch());
    const backup = store.exportBackup();
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.restore({ ...backup, sources: [{ ...backup.sources[0], text: "不同内容" }] })).toThrow("原文与现有记录冲突");
    expect(() => store.restore({ ...backup, tasks: [backup.tasks[0], backup.tasks[0]] })).toThrow("重复编号");
    expect(() => store.restore({ ...backup, sources: [] })).toThrow("缺少待办关联的原文");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });

  it.each(["not-json", JSON.stringify({ version: 2, tasks: [], sources: [], batches: {} }), JSON.stringify({ version: 1, tasks: [], sources: [], batches: {}, extra: true })])("损坏存储不会被静默当空数据或覆盖：%s", (raw) => {
    const storage = new FakeStorage();
    storage.setItem(BROWSER_STORAGE_KEY, raw);
    const store = new BrowserStore(storage);
    expect(() => store.snapshot()).toThrow("损坏或版本不兼容");
    expect(() => store.addBatch(batch())).toThrow("损坏或版本不兼容");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });

  it("额度和禁止存储错误不显示假成功，并保留旧数据", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const [task] = store.addBatch(batch()).tasks;
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    storage.failWrite = "quota";
    expect(() => store.update(task.id, { status: "done" })).toThrow("空间不足");
    expect(() => store.addBatch(batch(["更多事项"]))).toThrow("内容没有保存");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.snapshot().tasks[0].status).toBe("todo");
    storage.failWrite = "security";
    expect(() => store.remove(task.id)).toThrow("禁止保存");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    storage.failRead = true;
    expect(() => store.snapshot()).toThrow("禁止读取");
  });

  it("合并结果达到 5000 条后拒绝继续新增，超过容量的恢复不部分写入", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    store.addBatch(batch());
    const backup = store.exportBackup();
    const template = backup.tasks[0];
    const tasks = [template, ...Array.from({ length: 4_999 }, (_, index) => ({
      ...template, id: crypto.randomUUID(), title: `事项 ${index + 1}`,
    }))];
    store.restore({ ...backup, tasks });
    expect(store.snapshot().tasks).toHaveLength(5_000);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.addBatch(batch(["超限事项"]))).toThrow("最多保存 5000 条");
    const another = new BrowserStore(new FakeStorage());
    another.addBatch(batch(["新的事项"]));
    expect(() => store.restore(another.exportBackup())).toThrow("最多保存 5000 条");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });

  it("原文记录也遵守 5000 条上限", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    store.addBatch(batch());
    const backup = store.exportBackup();
    const sources = [...backup.sources, ...Array.from({ length: 4_999 }, () => ({
      ...backup.sources[0], id: crypto.randomUUID(),
    }))];
    store.restore({ ...backup, sources });
    expect(store.snapshot().sources).toHaveLength(5_000);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.addBatch(batch())).toThrow("最多保存 5000 条");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });

  it("清空只删除应用自己的 key，清空失败抛错", () => {
    const storage = new FakeStorage();
    storage.setItem("another-app", "keep-this");
    const store = new BrowserStore(storage);
    store.addBatch(batch());
    storage.failRemove = true;
    expect(() => store.clear()).toThrow("原数据未清空");
    storage.failRemove = false;
    store.clear();
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBeNull();
    expect(storage.getItem("another-app")).toBe("keep-this");
  });

  it("统一 API 适配响应形状一致，错误不伪装成成功", () => {
    const store = new BrowserStore(new FakeStorage());
    const saved = store.handleRequest<WorkspaceData>("/api/tasks", jsonOptions(batch()));
    expect(store.handleRequest("/api/tasks")).toEqual(saved);
    const id = saved.tasks[0].id;
    expect(store.handleRequest(`/api/tasks/${id}`, jsonOptions({ status: "done" }, "PATCH"))).toMatchObject({ status: "done", id });
    expect(store.handleRequest(`/api/tasks/${id}`, { method: "DELETE" })).toEqual({ ok: true });
    expect(() => store.handleRequest(`/api/tasks/${id}`, { method: "DELETE" })).toThrow("不存在");
    expect(store.handleRequest("/api/workspace", { method: "DELETE" })).toEqual({ ok: true });
  });
});

describe("静态站点 request", () => {
  it("本地模式的读写、导出和恢复不向后台发请求", async () => {
    const storage = new FakeStorage();
    const fetchSpy = vi.fn();
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_MODE", "true");
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    const { request, IS_STATIC_PREVIEW } = await import("./client");
    expect(IS_STATIC_PREVIEW).toBe(true);
    const saved = await request<WorkspaceData>("/api/tasks", jsonOptions(batch()));
    expect(saved.tasks).toHaveLength(1);
    const backup = await request("/api/export");
    await request("/api/workspace", { method: "DELETE" });
    expect((await request<WorkspaceData>("/api/tasks")).tasks).toHaveLength(0);
    await request("/api/restore", jsonOptions(backup));
    expect((await request<WorkspaceData>("/api/tasks")).tasks).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("正常模式保留原 fetch API 行为和错误信息", async () => {
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "批次冲突" }) });
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    const { request } = await import("./client");
    await expect(request("/api/tasks")).rejects.toThrow("批次冲突");
    expect(fetchSpy).toHaveBeenCalledWith("/api/tasks", undefined);
  });
});
