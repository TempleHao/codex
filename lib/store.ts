import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceRecord, Task, TaskInput, WorkspaceData } from "./types";
import { emptyLifeData, lifeDataSchema, mergeLifeBackups, type LifeData } from "./life";

export class StoreConflict extends Error {}

export class LifeStore {
  private db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        status TEXT NOT NULL CHECK (status IN ('todo', 'done')),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS life_data (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  private readTask(row: Record<string, unknown>): Task {
    return {
      ...JSON.parse(row.data as string) as TaskInput,
      id: row.id as string,
      sourceId: row.source_id as string,
      status: row.status as Task["status"],
      createdAt: row.created_at as string,
      completedAt: row.completed_at as string | null,
    };
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? this.readTask(row) : null;
  }

  snapshot(): WorkspaceData {
    return {
      tasks: this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid ASC").all().map(row => this.readTask(row)),
      sources: this.db.prepare("SELECT id, text, created_at AS createdAt FROM sources ORDER BY created_at DESC, rowid ASC").all() as unknown as SourceRecord[],
    };
  }

  getLife(): LifeData {
    const row = this.db.prepare("SELECT data FROM life_data WHERE id = 1").get();
    return row ? lifeDataSchema.parse(JSON.parse(row.data as string)) : emptyLifeData();
  }

  saveLife(input: unknown): LifeData {
    const data = lifeDataSchema.parse(input);
    this.db.prepare("INSERT INTO life_data (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(data));
    return data;
  }

  addBatch(batch: { batchId: string; sourceText: string; tasks: TaskInput[] }): WorkspaceData {
    const fingerprint = createHash("sha256").update(JSON.stringify({ sourceText: batch.sourceText, tasks: batch.tasks })).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT fingerprint FROM batches WHERE id = ?").get(batch.batchId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new StoreConflict("这一批已经保存过，内容发生了变化。请重新预览后再保存。");
      } else {
        const sourceId = randomUUID();
        const createdAt = new Date().toISOString();
        this.db.prepare("INSERT INTO sources (id, text, created_at) VALUES (?, ?, ?)").run(sourceId, batch.sourceText, createdAt);
        const insert = this.db.prepare("INSERT INTO tasks (id, source_id, status, created_at, completed_at, data) VALUES (?, ?, 'todo', ?, NULL, ?)");
        for (const item of batch.tasks) insert.run(randomUUID(), sourceId, createdAt, JSON.stringify(item));
        this.db.prepare("INSERT INTO batches (id, fingerprint) VALUES (?, ?)").run(batch.batchId, fingerprint);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.snapshot();
  }

  update(id: string, patch: Partial<TaskInput> & { status?: Task["status"] }): Task | null {
    const current = this.getTask(id);
    if (!current) return null;
    const { status: requestedStatus, ...changes } = patch;
    const status = requestedStatus ?? current.status;
    const updated: Task = {
      ...current,
      ...changes,
      status,
      completedAt: status === "done" ? current.completedAt ?? new Date().toISOString() : null,
    };
    const { id: _id, sourceId: _source, status: _status, createdAt: _created, completedAt: _completed, ...data } = updated;
    this.db.prepare("UPDATE tasks SET status = ?, completed_at = ?, data = ? WHERE id = ?").run(status, updated.completedAt, JSON.stringify(data), id);
    return updated;
  }

  remove(id: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.getTask(id);
      if (task) {
        this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM sources WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE source_id = ?)").run(task.sourceId, task.sourceId);
      }
      this.db.exec("COMMIT");
      return Boolean(task);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  restore(data: WorkspaceData & { life?: LifeData }): WorkspaceData {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertSource = this.db.prepare("INSERT INTO sources (id, text, created_at) VALUES (?, ?, ?)");
      for (const source of data.sources) {
        const prior = this.db.prepare("SELECT text, created_at FROM sources WHERE id = ?").get(source.id);
        if (prior) {
          if (prior.text !== source.text || prior.created_at !== source.createdAt) throw new StoreConflict("备份原文与现有记录冲突，未恢复任何内容。");
        } else insertSource.run(source.id, source.text, source.createdAt);
      }
      const insertTask = this.db.prepare("INSERT INTO tasks (id, source_id, status, created_at, completed_at, data) VALUES (?, ?, ?, ?, ?, ?)");
      for (const task of data.tasks) {
        const prior = this.getTask(task.id);
        if (prior) {
          const keys = Object.keys(task).sort() as (keyof Task)[];
          if (keys.some(key => JSON.stringify(prior[key]) !== JSON.stringify(task[key]))) throw new StoreConflict("备份待办与现有待办冲突，未恢复任何内容。请在空数据目录恢复旧备份。");
        } else {
          const { id, sourceId, status, createdAt, completedAt, ...input } = task;
          insertTask.run(id, sourceId, status, createdAt, completedAt, JSON.stringify(input));
        }
      }
      if (data.life !== undefined) {
        const incoming = lifeDataSchema.parse(data.life);
        let merged: LifeData;
        try { merged = mergeLifeBackups(this.getLife(), incoming); }
        catch (error) {
          throw new StoreConflict(error instanceof Error ? error.message : "备份阅读或思考与现有记录冲突，未恢复任何内容。");
        }
        this.saveLife(merged);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.snapshot();
  }
}

const cache = globalThis as typeof globalThis & { lifeStore?: LifeStore };

export function getStore(): LifeStore {
  if (!cache.lifeStore) {
    const directory = process.env.LIFE_DATA_DIR || path.join(process.cwd(), ".data");
    cache.lifeStore = new LifeStore(path.join(directory, "life.sqlite"));
  }
  return cache.lifeStore;
}
