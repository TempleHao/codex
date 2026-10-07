import { z } from "zod";
import { AREAS } from "./types";

export const IMPORT_LIMITS = {
  input: 100_000,
  sourceText: 20_000,
  tasks: 100,
  title: 300,
  notes: 5_000,
  sourceExcerpt: 2_000,
  clarification: 500,
  clarifications: 10,
} as const;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1];
}

/** Dates are local calendar dates, never timestamps or guessed relative dates. */
export const dateSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || null : value),
  z.string().refine(isCalendarDate, "日期必须是实际存在的 YYYY-MM-DD 日期").nullable(),
);

const titleSchema = z.string().trim()
  .min(1, "请填写任务标题")
  .max(IMPORT_LIMITS.title, `任务标题不能超过 ${IMPORT_LIMITS.title} 字`);
const notesSchema = z.string().max(IMPORT_LIMITS.notes, `备注不能超过 ${IMPORT_LIMITS.notes} 字`);
const areaSchema = z.enum(AREAS, { error: `领域必须是：${AREAS.join("、")}` });
const prioritySchema = z.enum(["normal", "high"], { error: "优先级必须是 normal 或 high" });
const clarificationSchema = z.array(
  z.string().trim().min(1, "待确认说明不能为空")
    .max(IMPORT_LIMITS.clarification, `每条待确认说明不能超过 ${IMPORT_LIMITS.clarification} 字`),
).max(IMPORT_LIMITS.clarifications, `每条任务最多 ${IMPORT_LIMITS.clarifications} 条待确认说明`);
const sourceExcerptSchema = z.string()
  .max(IMPORT_LIMITS.sourceExcerpt, `原文摘录不能超过 ${IMPORT_LIMITS.sourceExcerpt} 字`);

export const sourceTextSchema = z.string()
  .max(IMPORT_LIMITS.sourceText, `原文不能超过 ${IMPORT_LIMITS.sourceText} 字`);

export const taskInputSchema = z.object({
  title: titleSchema,
  notes: notesSchema.default(""),
  area: areaSchema.default("生活"),
  priority: prioritySchema.default("normal"),
  plannedDate: dateSchema.default(null),
  dueDate: dateSchema.default(null),
  needsClarification: clarificationSchema.default([]),
  sourceExcerpt: sourceExcerptSchema.default(""),
}).strict();

export const importBatchSchema = z.object({
  batchId: z.string().uuid("导入批次 ID 必须是有效 UUID"),
  sourceText: sourceTextSchema,
  tasks: z.array(taskInputSchema)
    .min(1, "至少需要一条任务")
    .max(IMPORT_LIMITS.tasks, `一次最多导入 ${IMPORT_LIMITS.tasks} 条任务`),
}).strict();

// Do not reuse defaulted fields here: omitted patch fields must stay omitted.
export const taskPatchSchema = z.object({
  status: z.enum(["todo", "done"], { error: "任务状态必须是 todo 或 done" }).optional(),
  title: titleSchema.optional(),
  notes: notesSchema.optional(),
  area: areaSchema.optional(),
  priority: prioritySchema.optional(),
  plannedDate: dateSchema.optional(),
  dueDate: dateSchema.optional(),
  needsClarification: clarificationSchema.optional(),
  sourceExcerpt: sourceExcerptSchema.optional(),
}).strict();

export function validationErrorMessage(error: z.ZodError): string {
  const fieldNames: Record<string, string> = {
    title: "标题", notes: "备注", area: "领域", priority: "优先级",
    plannedDate: "计划日期", dueDate: "截止日期", needsClarification: "待确认说明",
    sourceExcerpt: "原文摘录", sourceText: "原文", version: "格式版本", batchId: "批次 ID",
    tasks: "任务", status: "状态",
  };
  return error.issues.map((issue) => {
    const path = issue.path.map((part) => typeof part === "number"
      ? `第 ${part + 1} 条`
      : fieldNames[String(part)] ?? String(part)).join(" / ");
    if (issue.code === "unrecognized_keys") {
      return `${path ? `${path}：` : ""}存在不支持的字段：${issue.keys.join("、")}`;
    }
    const message = issue.code === "invalid_type"
      ? "字段缺失或类型不正确"
      : issue.message;
    return `${path ? `${path}：` : ""}${message}`;
  }).slice(0, 5).join("；");
}
