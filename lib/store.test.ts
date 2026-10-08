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
import { backupSchema } from "./backup";

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
function boardLife(bookId = "board-book"): LifeData {
  const data = life(bookId);
  const threadId = randomUUID();
  data.board.threads.push({ id: threadId, title: "慢慢理解什么值得投入", area: "思考", kind: "question", state: "active", description: " 没有期限，也不必变成任务。 ", createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "2026-10-07T13:00:00.000Z" });
  data.board.observations.push({ id: randomUUID(), threadId, area: "生活", kind: "experience", text: " 散步时愿意停下来。\n保留当时的原话。 ", date: "2026-10-07", createdAt: "2026-10-07T14:00:00.000Z" });
  data.board.reviews.push({ id: randomUUID(), date: "2026-10-07", title: "这段时间的人生回顾", noticed: "有些兴趣值得慢慢探索", changed: "不再急着给每件事安排结果", keep: "留一点空白", createdAt: "2026-10-07T15:00:00.000Z" });
  return data;
}
function mediaLife(bookId = "media-book"): LifeData {
  const data = boardLife(bookId);
  data.media.entries.push({
    id: `movie-${bookId}`, kind: "movie", title: "一部值得回看的电影", year: 2024, genres: ["剧情"], status: "watched", rating: 8.5,
    thought: "  看完以后想起了那次散步。\n保留感想原文。  ",
    history: [{ id: `view-${bookId}-1`, watchedAt: "2026-10-06" }, { id: `view-${bookId}-2`, watchedAt: "2026-10-07T20:30:00+08:00" }],
  });
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
  it("reads a legacy reading and thoughts row without rewriting it or its tasks", () => {
    const filename = databaseFile();
    const original = store(filename);
    const tasks = original.addBatch({ batchId: randomUUID(), sourceText: "模型迁移前的原文", tasks: [item] });
    const saved = original.saveLife(life());
    close(original);
    const raw = JSON.stringify({ reading: saved.reading, thoughts: saved.thoughts });
    const legacy = new DatabaseSync(filename);
    try { legacy.prepare("UPDATE life_data SET data = ? WHERE id = 1").run(raw); }
    finally { legacy.close(); }

    const upgraded = store(filename);
    expect(upgraded.getLife()).toEqual(saved);
    expect(upgraded.snapshot()).toEqual(tasks);
    const inspected = new DatabaseSync(filename);
    try { expect(inspected.prepare("SELECT data FROM life_data WHERE id = 1").get()?.data).toBe(raw); }
    finally { inspected.close(); }
  });

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

describe("persistent life board and compatibility", () => {
  it("restores an old v2 reading and thoughts backup while preserving the current life board", () => {
    const db = store();
    const originalTasks = db.addBatch({ batchId: randomUUID(), sourceText: "已有任务原文", tasks: [item] });
    const existing = db.saveLife(boardLife("existing-book"));
    const source = store();
    const incomingTasks = source.addBatch({ batchId: randomUUID(), sourceText: "旧版阅读备份原文", tasks: [item] });
    const incoming = life("backup-book");
    const oldLife = { reading: incoming.reading, thoughts: incoming.thoughts };
    const backup = backupSchema.parse({ format: "life-workbench-backup", version: 2, exportedAt: "2026-10-07T12:00:00.000Z", ...incomingTasks, life: oldLife });
    const restored = db.restore(backup);
    expect(restored.tasks).toEqual(expect.arrayContaining([...originalTasks.tasks, ...incomingTasks.tasks]));
    expect(db.getLife().board).toEqual(existing.board);
    expect(db.getLife().reading.books).toEqual([...existing.reading.books, ...incoming.reading.books]);
    expect(db.getLife().thoughts).toEqual([...existing.thoughts, ...incoming.thoughts]);
    expect(db.restore(backup)).toEqual(restored);
    expect(db.getLife().board).toEqual(existing.board);
    expect(oldLife).not.toHaveProperty("board");
  });

  it("persists and restores all life board fields, original wording and IDs across reopening and retries", () => {
    const filename = databaseFile();
    const db = store(filename);
    const tasks = db.addBatch({ batchId: randomUUID(), sourceText: "迁移前的原文", tasks: [item] });
    const saved = db.saveLife(boardLife());
    close(db);
    const reopened = store(filename);
    expect(reopened.getLife()).toEqual(saved);
    expect(reopened.snapshot()).toEqual(tasks);
    const backup = { ...reopened.snapshot(), life: reopened.getLife() };
    const restored = store();
    expect(restored.restore(backup)).toEqual(tasks);
    expect(restored.getLife()).toEqual(saved);
    expect(restored.restore(backup)).toEqual(tasks);
    expect(restored.getLife()).toEqual(saved);
  });

  it.each(["threads", "observations", "reviews"] as const)("rolls back new tasks, sources, reading and every board record on conflicting %s", collection => {
    const db = store();
    const tasks = db.addBatch({ batchId: randomUUID(), sourceText: "已有任务原文", tasks: [item] });
    const existing = db.saveLife(boardLife("existing-book"));
    const source = store();
    const incomingTasks = source.addBatch({ batchId: randomUUID(), sourceText: "不能部分恢复的新原文", tasks: [item] });
    const incoming = life("backup-book");
    incoming.board = structuredClone(existing.board);
    incoming.board.observations.push({ ...incoming.board.observations[0], id: randomUUID(), text: "不能部分恢复的经历" });
    if (collection === "threads") incoming.board.threads[0].title = "冲突的人生线头";
    if (collection === "observations") incoming.board.observations[0].text = "冲突的经历";
    if (collection === "reviews") incoming.board.reviews[0].noticed = "冲突的回顾";
    expect(() => db.restore({ ...incomingTasks, life: incoming })).toThrow(StoreConflict);
    expect(db.snapshot()).toEqual(tasks);
    expect(db.getLife()).toEqual(existing);
  });

  it("preserves the current board on legacy reading and thoughts saves and accepts an explicit empty board", () => {
    const db = store();
    const tasks = db.addBatch({ batchId: randomUUID(), sourceText: "兼容保留的原文", tasks: [item] });
    const existing = db.saveLife(boardLife("existing-book"));
    const incoming = life("edited-book");
    const updated = db.saveLife({ reading: incoming.reading, thoughts: incoming.thoughts });
    expect(updated).toEqual({ ...incoming, board: existing.board });
    expect(db.getLife()).toEqual(updated);
    expect(db.snapshot()).toEqual(tasks);

    const fullUpdate = { ...updated, thoughts: [{ ...updated.thoughts[0], body: "完整对象更新的思考" }] };
    expect(db.saveLife(fullUpdate)).toEqual(fullUpdate);
    expect(db.getLife().board).toEqual(existing.board);
    expect(() => db.saveLife({ ...fullUpdate, board: { threads: [] } })).toThrow();
    expect(db.getLife()).toEqual(fullUpdate);
    const cleared = { ...fullUpdate, board: emptyLifeData().board };
    expect(db.saveLife(cleared)).toEqual(cleared);
    expect(db.getLife()).toEqual(cleared);
    expect(db.snapshot()).toEqual(tasks);
  });
});

describe("persistent media and legacy backups", () => {
  it("defaults a missing media module on read without rewriting the SQLite row or other data", () => {
    const filename = databaseFile();
    const original = store(filename);
    const tasks = original.addBatch({ batchId: randomUUID(), sourceText: "影音模型之前的原话", tasks: [item] });
    const saved = original.saveLife(boardLife());
    close(original);
    const raw = JSON.stringify({ reading: saved.reading, thoughts: saved.thoughts, board: saved.board });
    const legacy = new DatabaseSync(filename);
    try { legacy.prepare("UPDATE life_data SET data = ? WHERE id = 1").run(raw); }
    finally { legacy.close(); }
    const upgraded = store(filename);
    expect(upgraded.getLife()).toEqual(saved);
    expect(upgraded.snapshot()).toEqual(tasks);
    const inspected = new DatabaseSync(filename);
    try { expect(inspected.prepare("SELECT data FROM life_data WHERE id = 1").get()?.data).toBe(raw); }
    finally { inspected.close(); }
  });

  it("preserves current media on legacy whole saves and old v1/v2 restores, with explicit clearing supported", () => {
    const db = store();
    const existing = db.saveLife(mediaLife());
    const legacy = { reading: existing.reading, thoughts: existing.thoughts, board: existing.board };
    expect(db.saveLife(legacy)).toEqual(existing);
    const source = store();
    const tasks = source.addBatch({ batchId: randomUUID(), sourceText: "旧备份原文", tasks: [item] });
    expect(db.restore(tasks)).toEqual(tasks);
    const backup = backupSchema.parse({ format: "life-workbench-backup", version: 2, exportedAt: "2026-10-07T12:00:00Z", ...tasks, life: legacy });
    db.restore(backup);
    expect(db.getLife()).toEqual(existing);
    expect(db.saveLife({ ...legacy, media: emptyLifeData().media })).toEqual({ ...existing, media: emptyLifeData().media });
    expect(db.snapshot()).toEqual(tasks);
  });

  it("round-trips media metadata, original thoughts and repeated dated viewings through reopening and complete backup", () => {
    const filename = databaseFile();
    const db = store(filename);
    const tasks = db.addBatch({ batchId: randomUUID(), sourceText: "独立事务原文", tasks: [item] });
    const saved = db.saveLife(mediaLife());
    close(db);
    const reopened = store(filename);
    expect(reopened.getLife()).toEqual(saved);
    const backup = backupSchema.parse({ format: "life-workbench-backup", version: 2, exportedAt: "2026-10-07T12:00:00Z", ...reopened.snapshot(), life: reopened.getLife() });
    const restored = store();
    expect(restored.restore(backup)).toEqual(tasks);
    expect(restored.getLife()).toEqual(saved);
    expect(restored.getLife().media.entries[0].history).toHaveLength(2);
    expect(restored.restore(backup)).toEqual(tasks);
    expect(restored.getLife()).toEqual(saved);
  });

  it("rolls back incoming tasks, sources and every life module on a media conflict", () => {
    const db = store();
    const existing = db.saveLife(mediaLife());
    const tasks = db.addBatch({ batchId: randomUUID(), sourceText: "已有事务原文", tasks: [item] });
    const source = store();
    const incomingTasks = source.addBatch({ batchId: randomUUID(), sourceText: "不能部分恢复的原文", tasks: [item] });
    const incoming = mediaLife("new-book");
    incoming.media.entries.push({ ...existing.media.entries[0], history: [{ ...existing.media.entries[0].history[0], watchedAt: "2026-10-08" }] });
    expect(() => db.restore({ ...incomingTasks, life: incoming })).toThrow(StoreConflict);
    expect(db.snapshot()).toEqual(tasks);
    expect(db.getLife()).toEqual(existing);
    expect(db.patchLife({ section: "media", expected: existing.media, value: emptyLifeData().media }).media.entries).toEqual([]);
  });
});

describe("atomic life module saves", () => {
  it.each(["board", "reading", "thoughts", "media"] as const)("rejects a stale %s snapshot across database connections without changing any record", section => {
    const filename = databaseFile();
    const first = store(filename);
    const second = store(filename);
    const original = first.saveLife(mediaLife());
    const tasks = first.addBatch({ batchId: randomUUID(), sourceText: "独立事务原文", tasks: [item] });
    const replacement = mediaLife("new-book");
    const saved = second.patchLife({ section, expected: original[section], value: replacement[section] });
    const inspected = new DatabaseSync(filename);
    try {
      const raw = inspected.prepare("SELECT data FROM life_data WHERE id = 1").get()?.data;
      expect(() => first.patchLife({ section, expected: original[section], value: original[section] })).toThrow(StoreConflict);
      expect(inspected.prepare("SELECT data FROM life_data WHERE id = 1").get()?.data).toBe(raw);
    } finally { inspected.close(); }
    expect(first.getLife()).toEqual(saved);
    expect(first.snapshot()).toEqual(tasks);
    // A rejected write releases its transaction, allowing a later valid save.
    expect(first.patchLife({ section, expected: saved[section], value: original[section] })).toEqual(original);
  });

  it("merges different modules saved from one old snapshot across database connections", () => {
    const filename = databaseFile();
    const first = store(filename);
    const second = store(filename);
    const original = first.getLife();
    const replacement = mediaLife();
    const tasks = second.addBatch({ batchId: randomUUID(), sourceText: "独立保留的事务", tasks: [item] });
    first.patchLife({ section: "board", expected: original.board, value: replacement.board });
    second.patchLife({ section: "reading", expected: original.reading, value: replacement.reading });
    second.patchLife({ section: "media", expected: original.media, value: replacement.media });
    expect(first.patchLife({ section: "thoughts", expected: original.thoughts, value: replacement.thoughts })).toEqual(replacement);
    expect(second.getLife()).toEqual(replacement);
    expect(second.snapshot()).toEqual(tasks);
    close(first);
    expect(store(filename).getLife()).toEqual(replacement);
  });

  it("rejects invalid module patches before writing and keeps the connection usable", () => {
    const db = store();
    const existing = db.saveLife(boardLife());
    const valid = { section: "board", expected: existing.board, value: existing.board };
    for (const input of [
      { ...valid, section: "unknown" },
      { ...valid, token: "rejected-value" },
      { section: "board", value: existing.board },
      { ...valid, value: { ...existing.board, observations: [{ ...existing.board.observations[0], date: "2026-02-30" }] } },
      { section: "thoughts", expected: existing.thoughts, value: [existing.thoughts[0], existing.thoughts[0]] },
    ]) {
      expect(() => db.patchLife(input)).toThrow();
      expect(db.getLife()).toEqual(existing);
    }
    expect(db.patchLife({ ...valid, value: emptyLifeData().board })).toEqual({ ...existing, board: emptyLifeData().board });
  });
});
