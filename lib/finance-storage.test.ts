import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserStore, BROWSER_STORAGE_KEY } from "./client";
import { backupSchema } from "./backup";
import { emptyFinanceLibrary, type FinanceLibrary } from "./finance";
import { emptyLifeData, type LifeData } from "./life";
import { LifeStore } from "./store";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  quotaExceeded = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  removeItem(key: string) { this.values.delete(key); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.quotaExceeded) throw new DOMException("Full", "QuotaExceededError");
    this.values.set(key, value);
  }
}
function finance(): FinanceLibrary {
  return { version: 1, periods: [{ start: "2026-07-01", end: "2026-07-31" }], importedAt: "2026-08-01T12:00:00Z", transactions: [{
    id: `alipay:${"a".repeat(64)}`, occurredAt: "2026-07-03T12:00:00+08:00", description: " 合成测试商品\n保留原文 ", counterparty: "合成测试商户", category: "生活日用", direction: "expense", amountCents: 1234, status: "交易成功", paymentMethod: "余额", area: "工作", areaSource: "manual", nature: "fixed", note: " 手动备注\n第二行 ",
  }] };
}
function life(): LifeData {
  const data = emptyLifeData();
  data.finance = finance();
  data.reading.books.push({ id: "synthetic-book", title: "保留的阅读", author: "测试作者", kind: "ebook", status: "reading" });
  return data;
}
function oldLife(data: LifeData) {
  const { finance: _finance, ...legacy } = data;
  return legacy;
}
function backup(data: unknown) {
  return { format: "life-workbench-backup", version: 2, exportedAt: "2026-08-01T12:00:00Z", tasks: [], sources: [], life: data };
}
function changedFinance(data: FinanceLibrary): FinanceLibrary {
  return { ...data, transactions: data.transactions.map(transaction => ({ ...transaction, nature: "daily", note: "更新的人工备注" })) };
}

describe("finance data protection in persistent stores", () => {
  it("round-trips complete browser backups with manual classification and original notes", () => {
    const first = new BrowserStore(new MemoryStorage());
    const original = life();
    first.saveLife(original);
    const exported = JSON.parse(JSON.stringify(first.exportBackup()));
    const storage = new MemoryStorage();
    const restored = new BrowserStore(storage);
    restored.restore(exported);
    expect(new BrowserStore(storage).getLife()).toEqual(original);
    restored.restore(exported);
    expect(restored.getLife()).toEqual(original);
  });

  it("defaults missing finance in old v2 backups and preserves existing finance on restore and old whole saves", () => {
    const legacy = backup(oldLife(life()));
    const parsed = backupSchema.parse(legacy);
    if (parsed.version !== 2) throw new Error("Expected v2 backup");
    expect(parsed.life.finance).toEqual(emptyFinanceLibrary());
    const fresh = new BrowserStore(new MemoryStorage());
    fresh.restore(legacy);
    expect(fresh.getLife().finance).toEqual(emptyFinanceLibrary());
    const populated = new BrowserStore(new MemoryStorage());
    populated.saveLife(life());
    populated.restore(legacy);
    expect(populated.getLife().finance).toEqual(finance());
    populated.saveLife({ ...oldLife(life()), thoughts: [] });
    expect(populated.getLife().finance).toEqual(finance());
  });

  it("updates only finance and refuses stale writes without discarding newer notes or reading", () => {
    const storage = new MemoryStorage();
    const firstTab = new BrowserStore(storage);
    const secondTab = new BrowserStore(storage);
    const original = life();
    firstTab.saveLife(original);
    const updated = changedFinance(original.finance);
    secondTab.patchLife({ section: "finance", expected: original.finance, value: updated });
    expect(firstTab.getLife().reading).toEqual(original.reading);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    expect(() => firstTab.patchLife({ section: "finance", expected: original.finance, value: emptyFinanceLibrary() })).toThrow("未保存本次内容");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(firstTab.getLife().finance).toEqual(updated);
  });

  it("rejects an entire conflicting browser backup including earlier new source records", () => {
    const storage = new MemoryStorage();
    const store = new BrowserStore(storage);
    const original = life();
    store.saveLife(original);
    const before = storage.getItem(BROWSER_STORAGE_KEY);
    const source = { id: randomUUID(), text: "冲突发生前也不能写入的合成原文", createdAt: "2026-08-01T12:00:00Z" };
    expect(() => store.restore({ ...backup({ ...original, finance: changedFinance(original.finance) }), sources: [source] })).toThrow("未恢复任何内容");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(before);
    expect(store.snapshot().sources).toEqual([]);
    expect(store.getLife()).toEqual(original);
  });

  it("leaves original browser data intact when a finance save or restore exceeds storage quota", () => {
    const storage = new MemoryStorage();
    const store = new BrowserStore(storage);
    const original = life();
    store.saveLife(original);
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    storage.quotaExceeded = true;
    expect(() => store.patchLife({ section: "finance", expected: original.finance, value: changedFinance(original.finance) })).toThrow("空间不足");
    const additional = { ...emptyLifeData(), finance: { ...finance(), transactions: [{ ...finance().transactions[0], id: `alipay:${"b".repeat(64)}` }] } };
    expect(() => store.restore(backup(additional))).toThrow("空间不足");
    expect(storage.getItem(BROWSER_STORAGE_KEY)).toBe(raw);
    expect(store.getLife()).toEqual(original);
  });

  it("preserves finance through old SQLite saves and isolated patches, then restores a portable backup", () => {
    const db = new LifeStore(":memory:");
    const restored = new LifeStore(":memory:");
    try {
      const original = life();
      db.saveLife(original);
      db.saveLife(oldLife(original));
      expect(db.getLife().finance).toEqual(original.finance);
      const updated = changedFinance(original.finance);
      db.patchLife({ section: "finance", expected: original.finance, value: updated });
      expect(db.getLife().reading).toEqual(original.reading);
      expect(() => db.patchLife({ section: "finance", expected: original.finance, value: emptyFinanceLibrary() })).toThrow("未保存本次内容");
      expect(db.getLife().finance).toEqual(updated);
      const portable = backupSchema.parse({ ...backup(db.getLife()), ...db.snapshot() });
      if (portable.version !== 2) throw new Error("Expected v2 backup");
      restored.restore(portable);
      expect(restored.getLife()).toEqual(db.getLife());
      const legacy = backupSchema.parse(backup(oldLife(original)));
      if (legacy.version !== 2) throw new Error("Expected v2 backup");
      restored.restore(legacy);
      expect(restored.getLife().finance).toEqual(updated);
    } finally { db.close(); restored.close(); }
  });

  it("rolls back earlier SQLite backup inserts when finance records conflict", () => {
    const db = new LifeStore(":memory:");
    try {
      const original = life();
      db.saveLife(original);
      const source = { id: randomUUID(), text: "应回滚的合成原文", createdAt: "2026-08-01T12:00:00Z" };
      expect(() => db.restore({ tasks: [], sources: [source], life: { ...original, finance: changedFinance(original.finance) } })).toThrow("未恢复任何内容");
      expect(db.snapshot()).toEqual({ tasks: [], sources: [] });
      expect(db.getLife()).toEqual(original);
    } finally { db.close(); }
  });
});
