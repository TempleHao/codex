import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { LifeStore, StoreConflict } from "./store";
import { chinaToday } from "./dates";
import type { TaskInput } from "./types";

const opened: LifeStore[] = [];
function store() { const db = new LifeStore(":memory:"); opened.push(db); return db; }
const item: TaskInput = { title: "预约洗牙", area: "健康", notes: "先询问费用", plannedDate: "2026-10-08", dueDate: null, priority: "normal", needsClarification: ["确认医院"], sourceExcerpt: "最近想洗牙" };
afterEach(() => opened.splice(0).forEach(db => db.close()));

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
