import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifeStore, StoreConflict } from "./store";
import { chinaToday } from "./dates";
import type { TaskInput } from "./types";
import { emptyLifeData, type LifeData } from "./life";

const opened: LifeStore[] = [];
const directories: string[] = [];
function store(filename = ":memory:") { const db = new LifeStore(filename); opened.push(db); return db; }
function close(db: LifeStore) { opened.splice(opened.indexOf(db), 1); db.close(); }
function databaseFile() {
  const directory = mkdtempSync(path.join(tmpdir(), "life-store-test-"));
  directories.push(directory);
  return path.join(directory, "life.sqlite");
}
function life(bookId = "book-1"): LifeData {
  const data = emptyLifeData();
  data.reading.books.push({ id: bookId, title: "阅读中的书", author: "作者", kind: "ebook", status: "reading" });
  data.reading.highlights.push({ id: `${bookId}-highlight`, bookId, text: "值得记下的原文" });
  data.thoughts.push({ id: randomUUID(), title: "读后的想法", body: "可以用在生活里的观察", createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T12:00:00.000Z", bookId, highlightId: `${bookId}-highlight`, sourceExcerpt: "值得记下的原文" });
  return data;
}
const item: TaskInput = { title: "预约洗牙", area: "健康", notes: "先询问费用", plannedDate: "2026-10-08", dueDate: null, priority: "normal", needsClarification: ["确认医院"], sourceExcerpt: "最近想洗牙" };
afterEach(() => {
  opened.splice(0).forEach(db => db.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe("persistent task workflow", () => {
  it("preserves source and treats retries as one atomic batch", () => {
    const db = store();
    const batch = { batchId: randomUUID(), sourceText: "最近想洗牙，还有一些别的事", tasks: [item, { ...item, title: "查询医保余额" }] };
    const first = db.addBatch(batch);
    const retried = db.addBatch(batch);
    expect(retried).toEqual(first);
    expect(first.tasks).toHaveLength(2);
    expect(first.sources).toHaveLength(1);
    expect(first.tasks[0].sourceId).toBe(first.sources[0].id);
    expect(first.tasks[0].needsClarification).toEqual(["确认医院"]);
    expect(() => db.addBatch({ ...batch, tasks: [item] })).toThrow(StoreConflict);
    expect(db.snapshot()).toEqual(first);
  });

  it("completes, reopens and edits without losing the original source", () => {
    const db = store();
    const task = db.addBatch({ batchId: randomUUID(), sourceText: "原话", tasks: [item] }).tasks[0];
    const done = db.update(task.id, { status: "done" })!;
    expect(done.completedAt).toBeTruthy();
    const edited = db.update(task.id, { title: "联系牙科诊所" })!;
    expect(edited.completedAt).toBe(done.completedAt);
    const reopened = db.update(task.id, { status: "todo" })!;
    expect(reopened.completedAt).toBeNull();
    expect(reopened.title).toBe("联系牙科诊所");
    expect(reopened.sourceId).toBe(task.sourceId);
    expect(db.remove(task.id)).toBe(true);
    expect(db.remove(task.id)).toBe(false);
    expect(db.snapshot().sources).toEqual([]);
  });

  it("keeps shared original text until the last related task is deleted", () => {
    const db = store();
    const snapshot = db.addBatch({ batchId: randomUUID(), sourceText: "共享原文", tasks: [item, { ...item, title: "整理桌面" }] });
    db.remove(snapshot.tasks[0].id);
    expect(db.snapshot().sources[0].text).toBe("共享原文");
    db.remove(snapshot.tasks[1].id);
    expect(db.snapshot()).toEqual({ tasks: [], sources: [] });
  });

  it("restores a complete snapshot and rejects conflicts without partial changes", () => {
    const source = store();
    const snapshot = source.addBatch({ batchId: randomUUID(), sourceText: "原始记录", tasks: [item] });
    const restored = store();
    expect(restored.restore(snapshot)).toEqual(snapshot);
    expect(restored.restore(snapshot)).toEqual(snapshot);
    const newSource = { id: randomUUID(), text: "不应部分恢复", createdAt: new Date().toISOString() };
    expect(() => restored.restore({ sources: [newSource, ...snapshot.sources], tasks: [{ ...snapshot.tasks[0], title: "冲突标题" }] })).toThrow(StoreConflict);
    expect(restored.snapshot()).toEqual(snapshot);
  });

  it("uses Shanghai day boundaries rather than the host timezone", () => {
    expect(chinaToday(new Date("2026-10-07T16:30:00Z"))).toBe("2026-10-08");
    expect(chinaToday(new Date("2026-10-07T15:59:59Z"))).toBe("2026-10-07");
  });
});

describe("persistent reading and thoughts", () => {
  it("adds the singleton table to a legacy task database without changing its data", () => {
    const filename = databaseFile();
    const original = store(filename);
    const tasks = original.addBatch({ batchId: randomUUID(), sourceText: "升级前的任务原文", tasks: [item] });
    close(original);
    const legacy = new DatabaseSync(filename);
    try { legacy.exec("DROP TABLE life_data"); }
    finally { legacy.close(); }

    const upgraded = store(filename);
    expect(upgraded.snapshot()).toEqual(tasks);
    expect(upgraded.getLife()).toEqual(emptyLifeData());
    const saved = upgraded.saveLife(life());
    close(upgraded);

    const reopened = store(filename);
    expect(reopened.snapshot()).toEqual(tasks);
    expect(reopened.getLife()).toEqual(saved);
  });

  it("validates full saves before replacing persisted reading and thoughts", () => {
    const db = store();
    const saved = db.saveLife(life());
    expect(() => db.saveLife({ ...saved, thoughts: [{ ...saved.thoughts[0], id: "invalid-id" }] })).toThrow();
    expect(() => db.saveLife({ ...saved, reading: { ...saved.reading, books: [] } })).toThrow();
    expect(db.getLife()).toEqual(saved);
    const edited = { ...saved, thoughts: [{ ...saved.thoughts[0], body: "修改后的想法" }] };
    expect(db.saveLife(edited)).toEqual(edited);
    expect(db.getLife()).toEqual(edited);
    expect(db.snapshot()).toEqual({ tasks: [], sources: [] });
  });

  it("keeps reading and thoughts when restoring a version 1 task snapshot", () => {
    const db = store();
    const saved = db.saveLife(life());
    const source = store();
    const tasks = source.addBatch({ batchId: randomUUID(), sourceText: "旧版备份原文", tasks: [item] });
    expect(db.restore(tasks)).toEqual(tasks);
    expect(db.getLife()).toEqual(saved);
  });

  it("merges version 2 reading and thoughts without losing existing records and supports retries", () => {
    const db = store();
    const existing = db.saveLife(life("existing-book"));
    const incoming = life("backup-book");
    const source = store();
    const tasks = source.addBatch({ batchId: randomUUID(), sourceText: "新版备份原文", tasks: [item] });
    const backup = { ...tasks, life: incoming };
    expect(db.restore(backup)).toEqual(tasks);
    const restored = db.getLife();
    expect(restored.reading.books).toEqual([...existing.reading.books, ...incoming.reading.books]);
    expect(restored.reading.highlights).toEqual([...existing.reading.highlights, ...incoming.reading.highlights]);
    expect(restored.thoughts).toEqual([...existing.thoughts, ...incoming.thoughts]);
    expect(db.restore(backup)).toEqual(tasks);
    expect(db.getLife()).toEqual(restored);
  });

  it.each(["book", "highlight", "thought"] as const)("rolls back restored tasks and sources on a conflicting %s", kind => {
    const db = store();
    const existing = db.saveLife(life());
    const incoming = structuredClone(existing);
    if (kind === "book") incoming.reading.books[0].title = "不同的书名";
    if (kind === "highlight") incoming.reading.highlights[0].text = "不同的划线原文";
    if (kind === "thought") incoming.thoughts[0].body = "不同的思考内容";
    const source = store();
    const tasks = source.addBatch({ batchId: randomUUID(), sourceText: "不能部分恢复的原文", tasks: [item] });

    expect(() => db.restore({ ...tasks, life: incoming })).toThrow(StoreConflict);
    expect(db.snapshot()).toEqual({ tasks: [], sources: [] });
    expect(db.getLife()).toEqual(existing);
  });

  it("preserves reading and thoughts when a task conflict aborts restore", () => {
    const db = store();
    const existing = db.saveLife(life("existing-book"));
    const tasks = db.addBatch({ batchId: randomUUID(), sourceText: "已有任务原文", tasks: [item] });
    const newSource = { id: randomUUID(), text: "不能部分恢复", createdAt: "2026-10-07T12:00:00.000Z" };
    expect(() => db.restore({ sources: [newSource, ...tasks.sources], tasks: [{ ...tasks.tasks[0], title: "冲突标题" }], life: life("backup-book") })).toThrow(StoreConflict);
    expect(db.snapshot()).toEqual(tasks);
    expect(db.getLife()).toEqual(existing);
  });
});
