import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserStore, BROWSER_STORAGE_KEY } from "./client";
import type { WorkspaceData } from "./types";
import { emptyLifeData, type LifeData } from "./life";

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

function life(bookId = "book-1"): LifeData {
  const data = emptyLifeData();
  data.reading.books.push({ id: bookId, title: "生活里的阅读", author: "作者", kind: "ebook", status: "reading", progress: 25, secondsRead: 3_600, deepLink: `weread://book/${bookId}` });
  data.reading.highlights.push({ id: `${bookId}-highlight`, bookId, text: "保留的划线原文", thought: "在阅读时写下的笔记", chapter: "第一章", createdAt: "2026-10-07T12:00:00.000Z" });
  data.reading.stats = { totalSeconds: 3_600, readingDays: 1, dailySeconds: [{ date: "2026-10-07", seconds: 3_600 }], mode: "overall", period: null, preferredHours: [{ hour: 20, seconds: 3_600 }] };
  data.reading.syncedAt = "2026-10-07T12:00:00.000Z";
  data.reading.source = "weread";
  data.thoughts.push({ id: crypto.randomUUID(), title: "读后的想法", body: " 原始思考\n可以实践的观察 ", createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T13:00:00.000Z", bookId, highlightId: `${bookId}-highlight`, sourceExcerpt: "保留的划线原文" });
  return data;
}

function boardLife(bookId = "board-book"): LifeData {
  const data = life(bookId);
  const threadId = crypto.randomUUID();
  data.board.threads.push({ id: threadId, title: "慢慢理解什么值得投入", area: "思考", kind: "question", state: "active", description: " 没有期限，也不必变成任务。 ", createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T13:00:00.000Z" });
  data.board.observations.push({ id: crypto.randomUUID(), threadId, area: "生活", kind: "feeling", text: " 散步时发现自己的步子慢了下来。\n愿意留意这种感觉。 ", date: "2026-10-07", createdAt: "2026-10-07T14:00:00.000Z" });
  data.board.reviews.push({ id: crypto.randomUUID(), date: "2026-10-07", title: "这段时间的人生回顾", noticed: "注意到自己喜欢独处", changed: "不再急着给每件事安排结果", keep: "留一点空白", createdAt: "2026-10-07T15:00:00.000Z" });
  return data;
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("浏览器独立存储", () => {
  it("初次读取不初始化数据，批次重复不新增，改变内容不写入", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    expect(store.snapshot()).toEqual({ tasks: [], sources: [] });
    expect(store.getLife()).toEqual(emptyLifeData());
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
    expect(backup.version).toBe(2);
    expect(backup.exportedAt).toMatch(/T.*Z$/);
    expect(Object.keys(backup).sort()).toEqual(["exportedAt", "format", "life", "sources", "tasks", "version"]);
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

describe("浏览器阅读与思考存储", () => {
  it("旧存储包含阅读与思考但缺少人生板时只在读取时补默认值，不覆盖原文或写回存储", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["迁移前保存的任务"], "迁移前保存的聊天原文"));
    const saved = store.saveLife(life());
    const legacy = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY)!);
    legacy.life = { reading: saved.reading, thoughts: saved.thoughts };
    const raw = JSON.stringify(legacy);
    storage.setItem(BROWSER_STORAGE_KEY, raw);
    const writes = storage.writes;

    const upgraded = new BrowserStore(storage);
    expect(upgraded.getLife()).toEqual(saved);
    expect(upgraded.snapshot()).toEqual(tasks);
    expect(upgraded.exportBackup()).toMatchObject({ version: 2, ...tasks, life: saved });
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });

  it("读取旧版存储时补充空阅读与思考，不写迁移数据，保存后保留任务与批次", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const input = batch(["旧版待办"], "旧版保存的完整原文");
    const tasks = store.addBatch(input);
    const legacy = JSON.parse(storage.getItem(BROWSER_STORAGE_KEY)!);
    delete legacy.life;
    const raw = JSON.stringify(legacy);
    storage.setItem(BROWSER_STORAGE_KEY, raw);
    const writes = storage.writes;

    const upgraded = new BrowserStore(storage);
    expect(upgraded.snapshot()).toEqual(tasks);
    expect(upgraded.getLife()).toEqual(emptyLifeData());
    expect(upgraded.exportBackup()).toMatchObject({ version: 2, ...tasks, life: emptyLifeData() });
    expect(upgraded.addBatch(input)).toEqual(tasks);
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);

    const saved = upgraded.saveLife(life());
    expect(upgraded.snapshot()).toEqual(tasks);
    expect(upgraded.addBatch(input)).toEqual(tasks);
    expect(new BrowserStore(storage).getLife()).toEqual(saved);
    expect(JSON.parse(storage.getItem(BROWSER_STORAGE_KEY)!)).toMatchObject({ version: 1, ...tasks, batches: legacy.batches, life: saved });
    expect(BROWSER_STORAGE_KEY).toBe("life-workbench-preview-v1");
  });

  it("保存阅读与思考保留原任务，随后任务增删改仍保留阅读与思考", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["已有任务"]));
    const saved = store.saveLife(life());
    expect(store.snapshot()).toEqual(tasks);
    const edited = store.update(tasks.tasks[0].id, { status: "done", title: "已修改任务" });
    const additional = store.addBatch(batch(["新增任务"])).tasks.find(task => task.id !== edited!.id)!;
    expect(store.remove(additional.id)).toBe(true);
    expect(store.snapshot().tasks).toEqual([edited]);
    expect(store.getLife()).toEqual(saved);
    expect(new BrowserStore(storage).getLife()).toEqual(saved);
  });

  it("恢复 v1 备份保留现有阅读与思考，并合并旧版任务", () => {
    const store = new BrowserStore(new FakeStorage());
    const existing = store.addBatch(batch(["已有任务"]));
    const saved = store.saveLife(life());
    const legacyStore = new BrowserStore(new FakeStorage());
    const incoming = legacyStore.addBatch(batch(["旧版备份任务"], "旧备份原文"));
    const legacyBackup = { format: "life-workbench-backup", version: 1, exportedAt: "2026-10-07T12:00:00.000Z", ...incoming };
    const restored = store.restore(legacyBackup);
    expect(restored.tasks).toHaveLength(2);
    expect(restored.tasks).toEqual(expect.arrayContaining([...existing.tasks, ...incoming.tasks]));
    expect(restored.sources).toEqual(expect.arrayContaining([...existing.sources, ...incoming.sources]));
    expect(store.getLife()).toEqual(saved);
    expect(store.restore(legacyBackup)).toEqual(restored);
    expect(store.getLife()).toEqual(saved);
  });

  it("v2 完整导出恢复保留阅读统计、划线、思考、原文与所有 ID，重复恢复幂等", () => {
    const first = new BrowserStore(new FakeStorage());
    const tasks = first.addBatch(batch(["待备份任务"], "原始聊天文本"));
    first.update(tasks.tasks[0].id, { status: "done" });
    const saved = first.saveLife(life());
    const backup = first.exportBackup();
    expect(backup).toMatchObject({ version: 2, life: saved, ...first.snapshot() });
    expect(backup).not.toHaveProperty("batches");

    const storage = new FakeStorage();
    const second = new BrowserStore(storage);
    expect(second.restore(backup)).toEqual(first.snapshot());
    expect(second.getLife()).toEqual(saved);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(second.restore(backup)).toEqual(first.snapshot());
    expect(second.getLife()).toEqual(saved);
    expect(JSON.parse(storage.getItem(BROWSER_STORAGE_KEY)!)).toEqual(JSON.parse(raw!));
    expect(new BrowserStore(storage).getLife()).toEqual(saved);
  });

  it("v2 增量恢复保留已有书籍、划线、思考与任务", () => {
    const store = new BrowserStore(new FakeStorage());
    const originalTasks = store.addBatch(batch(["原有任务"]));
    const existing = store.saveLife(life("existing-book"));
    const another = new BrowserStore(new FakeStorage());
    const additionalTasks = another.addBatch(batch(["备份任务"]));
    const incoming = another.saveLife(life("backup-book"));
    const backup = another.exportBackup();
    const restored = store.restore(backup);
    expect(restored.tasks).toEqual(expect.arrayContaining([...originalTasks.tasks, ...additionalTasks.tasks]));
    const merged = store.getLife();
    expect(merged.reading.books).toEqual([...existing.reading.books, ...incoming.reading.books]);
    expect(merged.reading.highlights).toEqual([...existing.reading.highlights, ...incoming.reading.highlights]);
    expect(merged.thoughts).toEqual([...existing.thoughts, ...incoming.thoughts]);
    expect(merged.reading.stats).toEqual(existing.reading.stats);
    expect(store.restore(backup)).toEqual(restored);
    expect(store.getLife()).toEqual(merged);
  });

  it.each(["book", "highlight", "thought", "stats"] as const)("阅读思考的 %s 冲突拒绝整份恢复，不写入任何新任务、原文或阅读记录", kind => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["现有任务"]));
    const existing = store.saveLife(life());
    const another = new BrowserStore(new FakeStorage());
    another.addBatch(batch(["不能部分恢复的任务"], "不能部分恢复的原文"));
    const incoming = structuredClone(existing);
    incoming.reading.books.push({ id: "additional-book", title: "不能部分恢复的书", author: "", kind: "ebook", status: "wanted" });
    incoming.thoughts.push({ ...incoming.thoughts[0], id: crypto.randomUUID(), title: "不能部分恢复的想法" });
    if (kind === "book") incoming.reading.books[0].title = "冲突书名";
    if (kind === "highlight") incoming.reading.highlights[0].text = "冲突划线";
    if (kind === "thought") incoming.thoughts[0].body = "冲突思考";
    if (kind === "stats") incoming.reading.stats!.totalSeconds = 7_200;
    const backup = { ...another.exportBackup(), version: 2, life: incoming };
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    const writes = storage.writes;
    expect(() => store.restore(backup)).toThrow("冲突");
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.snapshot()).toEqual(tasks);
    expect(store.getLife()).toEqual(existing);
  });

  it("任务冲突也拒绝同份备份中的新增阅读与思考", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["原有任务"]));
    const existing = store.saveLife(life("existing-book"));
    const backup = { ...store.exportBackup(), version: 2, tasks: [{ ...tasks.tasks[0], title: "冲突标题" }], life: life("backup-book") };
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.restore(backup)).toThrow("待办冲突");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.snapshot()).toEqual(tasks);
    expect(store.getLife()).toEqual(existing);
  });

  it.each(["life", "reading", "thought", "backup"] as const)("拒绝 %s 中的凭证额外字段，保留原数据且错误不反映字段值", location => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    store.addBatch(batch(["已有任务"]));
    const existing = store.saveLife(life());
    const credentialMarker = "fake-sensitive-value-for-rejection-test";
    let incoming: unknown = life("backup-book");
    if (location === "life") incoming = { ...incoming as LifeData, token: credentialMarker };
    if (location === "reading") incoming = { ...incoming as LifeData, reading: { ...(incoming as LifeData).reading, cookie: credentialMarker } };
    if (location === "thought") incoming = { ...incoming as LifeData, thoughts: [{ ...(incoming as LifeData).thoughts[0], wereadToken: credentialMarker }] };
    const backup = { ...store.exportBackup(), version: 2, life: incoming, ...(location === "backup" ? { authorization: credentialMarker } : {}) };
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    const writes = storage.writes;
    if (location !== "backup") expect(() => store.saveLife(incoming)).toThrow("不支持的字段");
    try { store.restore(backup); throw new Error("expected restore to reject"); }
    catch (error) {
      expect(String(error)).toContain("不支持的字段");
      expect(String(error)).not.toContain(credentialMarker);
    }
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).not.toContain(credentialMarker);
    expect(store.getLife()).toEqual(existing);
  });

  it("阅读思考保存或整份备份恢复遇到配额失败时不假成功，任务和生活数据均不改变", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["原有任务"]));
    const existing = store.saveLife(life("existing-book"));
    const another = new BrowserStore(new FakeStorage());
    another.addBatch(batch(["未能保存的任务"]));
    const incoming = another.saveLife(life("backup-book"));
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    const writes = storage.writes;
    storage.failWrite = "quota";
    expect(() => store.saveLife(incoming)).toThrow("内容没有保存");
    expect(() => store.restore(another.exportBackup())).toThrow("空间不足");
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.snapshot()).toEqual(tasks);
    expect(store.getLife()).toEqual(existing);
    storage.failWrite = "security";
    expect(() => store.saveLife(incoming)).toThrow("禁止保存");
    expect(store.getLife()).toEqual(existing);
  });

  it("生活 API 适配支持 GET 与 PUT，保存严格校验并拒绝超大请求", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    expect(store.handleRequest("/api/life")).toEqual(emptyLifeData());
    expect(storage.writes).toBe(0);
    const saved = life();
    expect(store.handleRequest("/api/life", jsonOptions(saved, "PUT"))).toEqual(saved);
    expect(store.handleRequest("/api/life")).toEqual(saved);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.handleRequest("/api/life", jsonOptions({ ...saved, secret: "rejected-value" }, "PUT"))).toThrow("不支持的字段");
    expect(() => store.handleRequest("/api/life", { method: "PUT", headers: { "Content-Type": "application/json" }, body: " ".repeat(5_000_001) })).toThrow("内容太大");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });
});

describe("人生板存储与迁移", () => {
  it("恢复旧 v2 阅读思考备份时保留已有人生板，并合并旧任务与阅读记录", () => {
    const store = new BrowserStore(new FakeStorage());
    const originalTasks = store.addBatch(batch(["保留旧功能中的任务"]));
    const existing = store.saveLife(boardLife("existing-book"));
    const another = new BrowserStore(new FakeStorage());
    const incomingTasks = another.addBatch(batch(["旧备份任务"], "保留旧备份原文"));
    const incoming = life("backup-book");
    const oldLife = { reading: incoming.reading, thoughts: incoming.thoughts };
    const backup = { ...another.exportBackup(), version: 2, life: oldLife };
    const restored = store.restore(backup);
    expect(restored.tasks).toEqual(expect.arrayContaining([...originalTasks.tasks, ...incomingTasks.tasks]));
    expect(store.getLife().board).toEqual(existing.board);
    expect(store.getLife().reading.books).toEqual([...existing.reading.books, ...incoming.reading.books]);
    expect(store.getLife().thoughts).toEqual([...existing.thoughts, ...incoming.thoughts]);
    expect(store.restore(backup)).toEqual(restored);
    expect(store.getLife().board).toEqual(existing.board);
    expect(oldLife).not.toHaveProperty("board");
  });

  it("人生线头、经历与回顾完整导出恢复，保留字段、原文和 ID，重复恢复幂等", () => {
    const first = new BrowserStore(new FakeStorage());
    const tasks = first.addBatch(batch(["迁移前的任务"]));
    const saved = first.saveLife(boardLife());
    const backup = first.exportBackup();
    expect(backup).toMatchObject({ version: 2, ...tasks, life: saved });
    const storage = new FakeStorage();
    const second = new BrowserStore(storage);
    expect(second.restore(backup)).toEqual(tasks);
    expect(second.getLife()).toEqual(saved);
    expect(second.restore(backup)).toEqual(tasks);
    expect(second.getLife()).toEqual(saved);
    expect(new BrowserStore(storage).getLife()).toEqual(saved);
  });

  it.each(["threads", "observations", "reviews"] as const)("人生板 %s 的同 ID 内容冲突拒绝整份恢复，任务、阅读和其他人生记录均不部分写入", collection => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["已有任务"]));
    const existing = store.saveLife(boardLife("existing-book"));
    const another = new BrowserStore(new FakeStorage());
    another.addBatch(batch(["不能部分恢复的任务"], "不能部分恢复的原文"));
    const incoming = life("backup-book");
    incoming.board = structuredClone(existing.board);
    incoming.board.observations.push({ ...incoming.board.observations[0], id: crypto.randomUUID(), text: "不能部分恢复的经历" });
    if (collection === "threads") incoming.board.threads[0].title = "冲突的人生线头";
    if (collection === "observations") incoming.board.observations[0].text = "冲突的经历";
    if (collection === "reviews") incoming.board.reviews[0].noticed = "冲突的回顾";
    const backup = { ...another.exportBackup(), version: 2, life: incoming };
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    const writes = storage.writes;
    expect(() => store.restore(backup)).toThrow("冲突");
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.snapshot()).toEqual(tasks);
    expect(store.getLife()).toEqual(existing);
  });

  it("旧调用保存阅读思考时保留人生板，完整对象更新同样保留，显式空人生板仍可清空", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const tasks = store.addBatch(batch(["兼容保留的任务"]));
    const existing = store.saveLife(boardLife("existing-book"));
    const incoming = life("edited-book");
    const updated = store.saveLife({ reading: incoming.reading, thoughts: incoming.thoughts });
    expect(updated).toEqual({ ...incoming, board: existing.board });
    expect(store.snapshot()).toEqual(tasks);
    expect(new BrowserStore(storage).getLife()).toEqual(updated);

    const fullUpdate = { ...updated, thoughts: [{ ...updated.thoughts[0], body: "进一步更新的阅读思考" }] };
    expect(store.saveLife(fullUpdate)).toEqual(fullUpdate);
    expect(store.getLife().board).toEqual(existing.board);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.saveLife({ ...fullUpdate, board: { threads: [] } })).toThrow();
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.saveLife({ ...fullUpdate, board: emptyLifeData().board })).toEqual({ ...fullUpdate, board: emptyLifeData().board });
    expect(store.getLife().board).toEqual(emptyLifeData().board);
    expect(store.snapshot()).toEqual(tasks);
  });

  it("旧阅读思考保存重新读取另一标签页最新人生板，避免覆盖其新增记录", () => {
    const storage = new FakeStorage();
    const firstTab = new BrowserStore(storage);
    const secondTab = new BrowserStore(storage);
    const prior = firstTab.saveLife(life());
    const latest = secondTab.saveLife({ ...prior, board: boardLife().board });
    const saved = firstTab.saveLife({ reading: prior.reading, thoughts: prior.thoughts });
    expect(saved.board).toEqual(latest.board);
    expect(secondTab.getLife()).toEqual(saved);
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
    const readingAndThoughts = life();
    expect(await request("/api/life", jsonOptions(readingAndThoughts, "PUT"))).toEqual(readingAndThoughts);
    expect(await request("/api/life")).toEqual(readingAndThoughts);
    const backup = await request("/api/export");
    await request("/api/workspace", { method: "DELETE" });
    expect((await request<WorkspaceData>("/api/tasks")).tasks).toHaveLength(0);
    expect(await request("/api/life")).toEqual(emptyLifeData());
    await request("/api/restore", jsonOptions(backup));
    expect((await request<WorkspaceData>("/api/tasks")).tasks).toHaveLength(1);
    expect(await request("/api/life")).toEqual(readingAndThoughts);
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

describe("人生模块快照保存", () => {
  it.each(["board", "reading", "thoughts"] as const)("%s 在另一标签页更新后拒绝旧快照，原数据和写入次数不变", section => {
    const storage = new FakeStorage();
    const firstTab = new BrowserStore(storage);
    const secondTab = new BrowserStore(storage);
    const original = firstTab.saveLife(boardLife());
    const replacement = boardLife("new-book");
    const saved = secondTab.patchLife({ section, expected: original[section], value: replacement[section] });
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    const writes = storage.writes;
    expect(() => firstTab.patchLife({ section, expected: original[section], value: original[section] })).toThrow("其他页面更新了");
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(firstTab.getLife()).toEqual(saved);
  });

  it("不同模块使用同一旧快照交错保存，保留最新人生板、阅读、思考与事务", () => {
    const storage = new FakeStorage();
    const firstTab = new BrowserStore(storage);
    const secondTab = new BrowserStore(storage);
    const original = firstTab.getLife();
    const replacement = boardLife();
    const tasks = secondTab.addBatch(batch(["与人生记录独立的事务"]));
    firstTab.patchLife({ section: "board", expected: original.board, value: replacement.board });
    secondTab.patchLife({ section: "reading", expected: original.reading, value: replacement.reading });
    const saved = firstTab.patchLife({ section: "thoughts", expected: original.thoughts, value: replacement.thoughts });
    expect(saved).toEqual(replacement);
    expect(secondTab.getLife()).toEqual(replacement);
    expect(secondTab.snapshot()).toEqual(tasks);
    const backup = new BrowserStore(storage).exportBackup();
    expect(backup.version).toBe(2);
    if (backup.version !== 2) throw new Error("Expected v2 fixture");
    expect(backup.life).toEqual(replacement);
  });

  it("严格拒绝未知模块、额外字段、缺失快照、无效人生记录和重复思考，不写入", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const existing = store.saveLife(boardLife());
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    const writes = storage.writes;
    const valid = { section: "board", expected: existing.board, value: existing.board };
    for (const input of [
      { ...valid, section: "unknown" },
      { ...valid, token: "rejected-value" },
      { section: "board", value: existing.board },
      { ...valid, value: { ...existing.board, observations: [{ ...existing.board.observations[0], date: "2026-02-30" }] } },
      { section: "thoughts", expected: existing.thoughts, value: [existing.thoughts[0], existing.thoughts[0]] },
    ]) expect(() => store.patchLife(input)).toThrow("内容格式有误");
    expect(storage.writes).toBe(writes);
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.getLife()).toEqual(existing);
  });

  it("模块保存遇到存储配额失败时保留所有旧记录，可用同一快照重试", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const existing = store.saveLife(life());
    const patch = { section: "board", expected: existing.board, value: boardLife().board };
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    storage.failWrite = "quota";
    expect(() => store.patchLife(patch)).toThrow("内容没有保存");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    storage.failWrite = null;
    expect(store.patchLife(patch)).toEqual({ ...existing, board: patch.value });
  });

  it("生活 PATCH 适配校验快照并拒绝超大请求", () => {
    const storage = new FakeStorage();
    const store = new BrowserStore(storage);
    const expected = store.getLife().board;
    const value = boardLife().board;
    expect(store.handleRequest("/api/life", jsonOptions({ section: "board", expected, value }, "PATCH"))).toEqual({ ...emptyLifeData(), board: value });
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => store.handleRequest("/api/life", jsonOptions({ section: "board", expected, value }, "PATCH"))).toThrow("其他页面更新了");
    expect(() => store.handleRequest("/api/life", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: " ".repeat(10_000_001) })).toThrow("内容太大");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
  });

  it("静态写操作通过共享锁执行，延后读取并合并其他模块，冲突不覆盖", async () => {
    const storage = new FakeStorage();
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_MODE", "true");
    vi.stubGlobal("window", { localStorage: storage });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    let release!: () => void;
    let queue: Promise<unknown> = new Promise<void>(resolve => { release = resolve; });
    const lockRequest = vi.fn((_key: string, callback: () => unknown) => {
      const operation = queue.then(callback);
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    });
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    vi.resetModules();
    const { request } = await import("./client");
    const original = emptyLifeData();
    const replacement = boardLife();
    const boardSave = request<LifeData>("/api/life", jsonOptions({ section: "board", expected: original.board, value: replacement.board }, "PATCH"));
    const readingSave = request<LifeData>("/api/life", jsonOptions({ section: "reading", expected: original.reading, value: replacement.reading }, "PATCH"));
    expect(storage.writes).toBe(0);
    expect(await request("/api/life")).toEqual(original);
    expect(lockRequest).toHaveBeenCalledTimes(2);
    release();
    await boardSave;
    expect(await readingSave).toEqual({ ...replacement, thoughts: [] });
    expect(lockRequest.mock.calls.every(([key]) => key === BROWSER_STORAGE_KEY)).toBe(true);

    const edits = [
      request("/api/life", jsonOptions({ section: "board", expected: replacement.board, value: { ...replacement.board, reviews: [] } }, "PATCH")),
      request("/api/life", jsonOptions({ section: "board", expected: replacement.board, value: original.board }, "PATCH")),
    ];
    const results = await Promise.allSettled(edits);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(storage.writes).toBe(3);
    expect((await request<LifeData>("/api/life")).board.reviews).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("全部静态 mutation 使用同一锁，读取不加锁", async () => {
    const storage = new FakeStorage();
    vi.stubEnv("NEXT_PUBLIC_PREVIEW_MODE", "true");
    vi.stubGlobal("window", { localStorage: storage });
    const lockRequest = vi.fn(async (_key: string, callback: () => unknown) => callback());
    vi.stubGlobal("navigator", { locks: { request: lockRequest } });
    vi.resetModules();
    const { request } = await import("./client");
    await request("/api/life");
    expect(lockRequest).not.toHaveBeenCalled();
    const tasks = await request<WorkspaceData>("/api/tasks", jsonOptions(batch()));
    await request("/api/life", jsonOptions(life(), "PUT"));
    await request(`/api/tasks/${tasks.tasks[0].id}`, jsonOptions({ status: "done" }, "PATCH"));
    await request(`/api/tasks/${tasks.tasks[0].id}`, { method: "DELETE" });
    const backup = await request("/api/export");
    await request("/api/workspace", { method: "DELETE" });
    await request("/api/restore", jsonOptions(backup));
    expect(lockRequest).toHaveBeenCalledTimes(6);
    expect(lockRequest.mock.calls.every(([key]) => key === BROWSER_STORAGE_KEY)).toBe(true);
  });
});
