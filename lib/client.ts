import { z } from "zod";
import packageInfo from "../package.json";
import { backupSchema, legacyBackupSchema, MAX_BACKUP_BYTES } from "./backup";
import { applyLifePatch, emptyLifeData, lifeDataSchema, lifePatchSchema, mergeLifeBackups, type LifeData } from "./life";
import type { SourceRecord, Task, WorkspaceData } from "./types";
import { importBatchSchema, taskPatchSchema, validationErrorMessage } from "./validation";
import { getWorkspaceLockState, withUnlockedWorkspace } from "./workspace-lock";

export const IS_STATIC_PREVIEW = process.env.NEXT_PUBLIC_PREVIEW_MODE === "true";
export const APP_VERSION = packageInfo.version;
export const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const BROWSER_STORAGE_KEY = "life-workbench-preview-v1";
const MAX_RECORDS = 5_000;

const storedSchema = z.object({
  version: z.literal(1),
  tasks: legacyBackupSchema.shape.tasks,
  sources: legacyBackupSchema.shape.sources,
  life: lifeDataSchema.default(emptyLifeData),
  batches: z.record(z.uuid(), z.object({ canonical: z.string(), sourceId: z.uuid() }).strict()),
}).strict().superRefine((state, context) => {
  const sourceIds = new Set(state.sources.map(source => source.id));
  if (sourceIds.size !== state.sources.length || new Set(state.tasks.map(task => task.id)).size !== state.tasks.length) {
    context.addIssue({ code: "custom", message: "本地数据存在重复编号。" });
  }
  if (state.tasks.some(task => !sourceIds.has(task.sourceId))) {
    context.addIssue({ code: "custom", message: "本地数据缺少关联原文。" });
  }
  if (Object.values(state.batches).some(batch => !sourceIds.has(batch.sourceId))) {
    context.addIssue({ code: "custom", message: "本地导入批次缺少关联原文。" });
  }
});

type StoredState = z.infer<typeof storedSchema>;
export type BrowserBackup = z.infer<typeof backupSchema>;

function emptyState(): StoredState {
  return { version: 1, tasks: [], sources: [], batches: {}, life: emptyLifeData() };
}

function validate<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`内容格式有误：${validationErrorMessage(parsed.error)}`);
  return parsed.data;
}

function snapshotOf(state: StoredState): WorkspaceData {
  // Stable sorting preserves the order within one imported batch, as on the server.
  return {
    tasks: [...state.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    sources: [...state.sources].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

function sameRecord(left: Task | SourceRecord, right: Task | SourceRecord): boolean {
  const fields = Object.keys(right).sort();
  return fields.every(field => JSON.stringify(left[field as keyof typeof left]) === JSON.stringify(right[field as keyof typeof right]));
}

function requireCapacity(state: StoredState): void {
  if (state.tasks.length > MAX_RECORDS || state.sources.length > MAX_RECORDS) {
    throw new Error(`本地最多保存 ${MAX_RECORDS} 条待办和 ${MAX_RECORDS} 条原文，未保存本次内容。请先导出备份并整理数据。`);
  }
}

/**
 * GitHub Pages mode stores data only in this browser. There is no upload or
 * device synchronization; JSON export is the user's portable backup.
 * No state is cached between operations, so another tab's latest save is read.
 */
export class BrowserStore {
  constructor(private readonly storage: Storage) {}

  private read(): StoredState {
    let raw: string | null;
    try {
      raw = this.storage.getItem(BROWSER_STORAGE_KEY);
    } catch {
      throw new Error("浏览器禁止读取本地数据，请允许此网站使用存储，或退出无痕模式后重试。");
    }
    if (raw === null) return emptyState();
    try {
      return storedSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("浏览器中的生活数据已损坏或版本不兼容，未修改原数据。请先保留浏览器数据或已有备份，再处理恢复。");
    }
  }

  private write(state: StoredState): void {
    requireCapacity(state);
    const serialized = JSON.stringify(state);
    try {
      // A native Storage.setItem is atomic: a quota/security failure leaves the old value intact.
      this.storage.setItem(BROWSER_STORAGE_KEY, serialized);
    } catch (error) {
      if (typeof error === "object" && error !== null && "name" in error && error.name === "QuotaExceededError") {
        throw new Error("浏览器本地存储空间不足，内容没有保存。请先导出备份并清理空间后重试。");
      }
      throw new Error("浏览器禁止保存本地数据，内容没有保存。请允许此网站使用存储，或退出无痕模式后重试。");
    }
  }

  snapshot(): WorkspaceData { return snapshotOf(this.read()); }

  getLife(): LifeData { return this.read().life; }

  saveLife(input: unknown): LifeData {
    const life = validate(lifeDataSchema, input);
    const state = this.read();
    // Older whole-document callers omit modules introduced after their saved version.
    if (input !== null && typeof input === "object") {
      if (!Object.hasOwn(input, "board")) life.board = state.life.board;
      if (!Object.hasOwn(input, "media")) life.media = state.life.media;
      if (!Object.hasOwn(input, "finance")) life.finance = state.life.finance;
    }
    state.life = life;
    this.write(state);
    return life;
  }

  patchLife(input: unknown): LifeData {
    const patch = validate(lifePatchSchema, input);
    const state = this.read();
    state.life = applyLifePatch(state.life, patch);
    this.write(state);
    return state.life;
  }

  addBatch(input: unknown): WorkspaceData {
    const batch = validate(importBatchSchema, input);
    const state = this.read();
    const canonical = JSON.stringify({ sourceText: batch.sourceText, tasks: batch.tasks });
    const previous = state.batches[batch.batchId];
    if (previous) {
      if (previous.canonical !== canonical) throw new Error("这一批已经保存过，内容发生了变化。请重新预览后再保存。");
      return snapshotOf(state);
    }
    if (state.tasks.length + batch.tasks.length > MAX_RECORDS || state.sources.length + 1 > MAX_RECORDS) {
      throw new Error(`本地最多保存 ${MAX_RECORDS} 条待办和 ${MAX_RECORDS} 条原文，未保存本次内容。请先导出备份并整理数据。`);
    }
    const sourceId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    state.sources.push({ id: sourceId, text: batch.sourceText, createdAt });
    state.tasks.push(...batch.tasks.map(item => ({
      ...item, id: crypto.randomUUID(), sourceId, status: "todo" as const, createdAt, completedAt: null,
    })));
    state.batches[batch.batchId] = { canonical, sourceId };
    this.write(state);
    return snapshotOf(state);
  }

  update(id: string, input: unknown): Task | null {
    const patch = validate(taskPatchSchema, input);
    const state = this.read();
    const index = state.tasks.findIndex(task => task.id === id);
    if (index === -1) return null;
    const current = state.tasks[index];
    const { status: requestedStatus, ...changes } = patch;
    const status = requestedStatus ?? current.status;
    const updated: Task = {
      ...current, ...changes, status,
      completedAt: status === "done" ? current.completedAt ?? new Date().toISOString() : null,
    };
    state.tasks[index] = updated;
    this.write(state);
    return updated;
  }

  remove(id: string): boolean {
    const state = this.read();
    const task = state.tasks.find(item => item.id === id);
    if (!task) return false;
    state.tasks = state.tasks.filter(item => item.id !== id);
    if (!state.tasks.some(item => item.sourceId === task.sourceId)) {
      state.sources = state.sources.filter(source => source.id !== task.sourceId);
      // Delete all copies of the removed source, including the retry cache.
      for (const [batchId, batch] of Object.entries(state.batches)) {
        if (batch.sourceId === task.sourceId) delete state.batches[batchId];
      }
    }
    this.write(state);
    return true;
  }

  exportBackup(): BrowserBackup {
    const state = this.read();
    return { format: "life-workbench-backup", version: 2, exportedAt: new Date().toISOString(), ...snapshotOf(state), life: state.life };
  }

  restore(input: unknown): WorkspaceData {
    const backup = validate(backupSchema, input);
    const state = this.read();
    const sourceById = new Map(state.sources.map(source => [source.id, source]));
    const taskById = new Map(state.tasks.map(task => [task.id, task]));
    for (const source of backup.sources) {
      const prior = sourceById.get(source.id);
      if (prior && !sameRecord(prior, source)) throw new Error("备份原文与现有记录冲突，未恢复任何内容。");
      if (!prior) { state.sources.push(source); sourceById.set(source.id, source); }
    }
    for (const task of backup.tasks) {
      const prior = taskById.get(task.id);
      if (prior && !sameRecord(prior, task)) throw new Error("备份待办与现有待办冲突，未恢复任何内容。请保留两份备份后核对。");
      if (!prior) { state.tasks.push(task); taskById.set(task.id, task); }
    }
    if (backup.version === 2) state.life = mergeLifeBackups(state.life, backup.life);
    // All validation, conflict checks and capacity checks finish before the single write.
    this.write(state);
    return snapshotOf(state);
  }

  clear(): void {
    try { this.storage.removeItem(BROWSER_STORAGE_KEY); }
    catch { throw new Error("浏览器禁止清空本地数据，原数据未清空。请允许此网站使用存储后重试。"); }
  }

  /** Same response shapes as the server API; this method never calls fetch. */
  handleRequest<T>(url: string, options?: RequestInit): T {
    const method = (options?.method || "GET").toUpperCase();
    let pathname = url.split("?")[0];
    if (APP_BASE_PATH && pathname.startsWith(`${APP_BASE_PATH}/`)) pathname = pathname.slice(APP_BASE_PATH.length);
    const readBody = (maxBytes = 500_000): unknown => {
      if (!new Headers(options?.headers).get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        throw new Error("请提交 JSON 格式的内容。");
      }
      if (typeof options?.body !== "string" || !options.body) throw new Error("提交内容为空。");
      if (new TextEncoder().encode(options.body).byteLength > maxBytes) throw new Error("内容太大，请分批导入。");
      try { return JSON.parse(options.body); }
      catch { throw new Error("JSON 内容不完整，请检查后重试。"); }
    };
    let result: unknown;
    if (pathname === "/api/tasks" && method === "GET") result = this.snapshot();
    else if (pathname === "/api/life" && method === "GET") result = this.getLife();
    else if (pathname === "/api/life" && method === "PUT") result = this.saveLife(readBody(5_000_000));
    else if (pathname === "/api/life" && method === "PATCH") result = this.patchLife(readBody(10_000_000));
    else if (pathname === "/api/tasks" && method === "POST") result = this.addBatch(readBody());
    else if (pathname === "/api/export" && method === "GET") result = this.exportBackup();
    else if (pathname === "/api/restore" && method === "POST") result = this.restore(readBody(MAX_BACKUP_BYTES));
    else if (pathname === "/api/workspace" && method === "DELETE") { this.clear(); result = { ok: true }; }
    else if (/^\/api\/tasks\/[^/]+$/.test(pathname) && (method === "PATCH" || method === "DELETE")) {
      const id = pathname.slice("/api/tasks/".length);
      if (method === "PATCH") {
        const task = this.update(id, readBody());
        if (!task) throw new Error("这条待办不存在，可能已经删除。");
        result = task;
      } else {
        if (!this.remove(id)) throw new Error("这条待办不存在，可能已经删除。");
        result = { ok: true };
      }
    } else throw new Error("本地模式不支持此操作。");
    return result as T;
  }
}

function currentBrowserStore(): BrowserStore {
  if (typeof window === "undefined") throw new Error("浏览器本地模式需要在网页中打开。");
  let storage: Storage;
  try { storage = window.localStorage; }
  catch { throw new Error("浏览器禁止使用本地存储，请允许此网站使用存储，或退出无痕模式后重试。"); }
  return new BrowserStore(storage);
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  if (IS_STATIC_PREVIEW) {
    if (getWorkspaceLockState().configured) return withUnlockedWorkspace(storage => new BrowserStore(storage).handleRequest<T>(url, options));
    const method = (options?.method || "GET").toUpperCase();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && typeof navigator !== "undefined" && navigator.locks) {
      // Every tab uses one exclusive lock for the shared localStorage document.
      return navigator.locks.request(BROWSER_STORAGE_KEY, () => currentBrowserStore().handleRequest<T>(url, options));
    }
    return currentBrowserStore().handleRequest<T>(url, options);
  }
  const target = APP_BASE_PATH && /^\/(?!\/)/.test(url) && !url.startsWith(`${APP_BASE_PATH}/`) ? `${APP_BASE_PATH}${url}` : url;
  const response = await fetch(target, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `操作失败（${response.status}），请稍后重试。`);
  return body as T;
}
