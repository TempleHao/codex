import { z } from "zod";
import { taskInputSchema } from "./validation";
import { lifeDataSchema } from "./life";

// Allow room for UTF-8 Chinese text and indentation in browser-generated backups.
export const MAX_BACKUP_BYTES = 20_000_000;

const timestamp = z.iso.datetime({ offset: true });
const sourceSchema = z.object({ id: z.uuid(), text: z.string().max(20_000), createdAt: timestamp }).strict();
const taskSchema = taskInputSchema.extend({
  id: z.uuid(), sourceId: z.uuid(), status: z.enum(["todo", "done"]), createdAt: timestamp, completedAt: timestamp.nullable(),
}).strict().refine(task => (task.status === "todo") === (task.completedAt === null), "完成状态与完成时间不一致。");

function checkTaskRelations(data: { tasks: z.infer<typeof taskSchema>[]; sources: z.infer<typeof sourceSchema>[] }, context: z.RefinementCtx) {
  const sourceIds = new Set(data.sources.map(source => source.id));
  const taskIds = new Set(data.tasks.map(task => task.id));
  if (sourceIds.size !== data.sources.length || taskIds.size !== data.tasks.length) context.addIssue({ code: "custom", message: "备份存在重复编号。" });
  for (const task of data.tasks) if (!sourceIds.has(task.sourceId)) context.addIssue({ code: "custom", message: "备份缺少待办关联的原文。" });
}

export const legacyBackupSchema = z.object({
  format: z.literal("life-workbench-backup"),
  version: z.literal(1),
  exportedAt: timestamp,
  tasks: z.array(taskSchema).max(5000),
  sources: z.array(sourceSchema).max(5000),
}).strict().superRefine(checkTaskRelations);

export const fullBackupSchema = z.object({ ...legacyBackupSchema.shape, version: z.literal(2), life: lifeDataSchema }).strict().superRefine(checkTaskRelations);
export const backupSchema = z.discriminatedUnion("version", [legacyBackupSchema, fullBackupSchema]);
