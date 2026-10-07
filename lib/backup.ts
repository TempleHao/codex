import { z } from "zod";
import { taskInputSchema } from "./validation";

const timestamp = z.iso.datetime({ offset: true });
const sourceSchema = z.object({ id: z.uuid(), text: z.string().max(20_000), createdAt: timestamp }).strict();
const taskSchema = taskInputSchema.extend({
  id: z.uuid(), sourceId: z.uuid(), status: z.enum(["todo", "done"]), createdAt: timestamp, completedAt: timestamp.nullable(),
}).strict().refine(task => (task.status === "todo") === (task.completedAt === null), "完成状态与完成时间不一致。");

export const backupSchema = z.object({
  format: z.literal("life-workbench-backup"),
  version: z.literal(1),
  exportedAt: timestamp,
  tasks: z.array(taskSchema).max(5000),
  sources: z.array(sourceSchema).max(5000),
}).strict().superRefine((data, context) => {
  const sourceIds = new Set(data.sources.map(source => source.id));
  const taskIds = new Set(data.tasks.map(task => task.id));
  if (sourceIds.size !== data.sources.length || taskIds.size !== data.tasks.length) context.addIssue({ code: "custom", message: "备份存在重复编号。" });
  for (const task of data.tasks) if (!sourceIds.has(task.sourceId)) context.addIssue({ code: "custom", message: "备份缺少待办关联的原文。" });
});
