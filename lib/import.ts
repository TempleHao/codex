import { z } from "zod";
import type { ImportDraft, TaskInput } from "./types";
import {
  IMPORT_LIMITS, dateSchema, sourceTextSchema, taskInputSchema, validationErrorMessage,
} from "./validation";

const documentSchema = z.object({
  version: z.literal(1, { error: "导入格式版本必须是 1" }),
  sourceText: sourceTextSchema,
  tasks: z.array(taskInputSchema).min(1, "至少需要一条任务")
    .max(IMPORT_LIMITS.tasks, `一次最多导入 ${IMPORT_LIMITS.tasks} 条任务`),
}).strict();

const RELATIVE_DATE = /今天|今日|今早|今晚|今夜|明天|明日|明早|明晚|大后天|后天|昨天|昨日|前天|下下周|这周|本周|下周|这星期|本星期|下星期|这个月|这月|本月|下个月|下月|月底|月初|周末|本季度|下季度|今年|明年|后年|年底|年初|稍后|过几天|一会儿?|近日|近期|(?:\d+|[一二三四五六七八九十两]+)(?:天|周|个月|月|年)(?:后|内|前)|(?:周|星期|礼拜)[一二三四五六日天]/g;
const RECURRENCE = /每(?:天|日|周|星期|月|年|季度|工作日|次)|每隔[^，。；;\s]{1,12}|隔天|隔日|隔周|隔月|工作日|定期|周期|循环/g;

function matches(pattern: RegExp, text: string): string[] {
  // String.match uses a fresh global-regexp scan, rather than retaining lastIndex.
  return [...new Set(text.match(pattern) ?? [])];
}

function describeMatches(values: string[]): string {
  return `${values.slice(0, 8).join("、")}${values.length > 8 ? `等 ${values.length} 处` : ""}`;
}

function annotateTask(task: TaskInput, warnings: string[], taskIndex: number, additional: string[] = []): TaskInput {
  const text = `${task.title}\n${task.notes}`;
  const clarifications = [...task.needsClarification];
  const generated = [...additional];
  const relativeDates = matches(RELATIVE_DATE, text);
  const recurrences = matches(RECURRENCE, text);
  if (relativeDates.length) {
    generated.push(`包含相对日期（${describeMatches(relativeDates)}），请确认具体日期；系统未自动换算。`);
  }
  if (recurrences.length) {
    generated.push(`包含周期安排（${describeMatches(recurrences)}），请确认如何重复；当前仅导入一次任务。`);
  }
  for (const message of new Set(generated)) {
    if (clarifications.includes(message)) continue;
    if (clarifications.length < IMPORT_LIMITS.clarifications) {
      clarifications.push(message);
    } else {
      // The user's valid notes take precedence. Overflowing generated hints remain visible.
      warnings.push(`第 ${taskIndex + 1} 条（“${task.title}”）：${message}原有待确认说明已全部保留，此提示单独显示。`);
    }
  }
  return taskInputSchema.parse({ ...task, needsClarification: clarifications });
}

function summarizeWarnings(tasks: TaskInput[], warnings: string[]): void {
  const seen = new Map<string, number>();
  tasks.forEach((task, index) => {
    const key = task.title.normalize("NFC").replace(/\s+/g, " ").toLocaleLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      warnings.push(`第 ${index + 1} 条与第 ${prior + 1} 条标题相同（“${task.title}”），已保留，请检查是否重复。`);
    } else {
      seen.set(key, index);
    }
  });
  const unresolved = tasks.filter((task) => task.needsClarification.length > 0).length;
  if (unresolved) warnings.push(`有 ${unresolved} 条任务仍需确认，请检查待确认说明。`);
}

function unwrapFence(input: string): string {
  const match = input.match(/^```(?:json|markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return match ? match[1].trim() : input;
}

function parseJSON(input: string): ImportDraft {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("JSON 格式有误，请检查引号、逗号和括号，或复制完整的 JSON 内容。");
  }
  const parsed = documentSchema.parse(value);
  const warnings: string[] = [];
  const tasks = parsed.tasks.map((task, index) => annotateTask(task, warnings, index));
  summarizeWarnings(tasks, warnings);
  return { sourceText: parsed.sourceText, tasks, warnings };
}

/** Split metadata while letting a literal pipe be written as \|. */
function splitFields(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (line[index] === "|") {
      parts.push(current.trim());
      current = "";
    } else {
      current += line[index];
    }
  }
  parts.push(current.trim());
  return parts;
}

function metadataDate(value: string, label: string, clarifications: string[]): string | null {
  if (/\d{4}-\d{2}-\d{2}/.test(value)) {
    const result = dateSchema.safeParse(value);
    if (!result.success) throw new Error(`${label}必须是实际存在的 YYYY-MM-DD 日期，或留空。`);
    return result.data;
  }
  if (matches(RELATIVE_DATE, value).length || matches(RECURRENCE, value).length) {
    clarifications.push(`${label}“${value}”需确认具体日期，系统未自动换算。`);
    return null;
  }
  const result = dateSchema.safeParse(value);
  if (!result.success) throw new Error(`${label}必须是实际存在的 YYYY-MM-DD 日期，或留空。`);
  return result.data;
}

function parseText(input: string): ImportDraft {
  sourceTextSchema.parse(input);
  const warnings: string[] = [];
  const tasks: TaskInput[] = [];
  let ordinaryLines = 0;
  let completedLines = 0;
  let headings = 0;

  input.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    if (/^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line)) {
      headings += 1;
      return;
    }
    const listed = line.match(/^(?:[-*+]\s+|\d+[.)、]\s*)(.*)$/);
    const withoutList = listed ? listed[1] : line;
    const checkbox = withoutList.match(/^\[([ xX])\]\s*(.*)$/);
    if (checkbox && checkbox[1].toLowerCase() === "x") {
      completedLines += 1;
      return;
    }
    const content = (checkbox ? checkbox[2] : listed ? listed[1] : line).trim();
    // Only explicit completion markers are skipped; no completion is inferred from a date.
    if (!checkbox && /^(?:已完成|已办妥|已经完成|已做完|已解决)(?:\s|[:：]|$)|[（(]已完成[）)]$/.test(content)) {
      completedLines += 1;
      return;
    }
    if (!checkbox && !listed) ordinaryLines += 1;
    if (!content) throw new Error(`第 ${index + 1} 行缺少任务标题。`);

    const [first, ...fields] = splitFields(content);
    const data: Record<string, unknown> = { title: first };
    const clarifications: string[] = [];
    const metadataClarifications: string[] = [];
    const present = new Set<string>();
    fields.forEach((field) => {
      const pair = field.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
      if (!pair) {
        data.title = `${data.title} | ${field}`;
        return;
      }
      const label = pair[1].trim();
      const value = pair[2].trim();
      if (present.has(label)) throw new Error(`第 ${index + 1} 行的“${label}”重复，请合并后再导入。`);
      present.add(label);
      switch (label) {
        case "计划":
          data.plannedDate = metadataDate(value, "计划日期", metadataClarifications);
          break;
        case "截止":
          data.dueDate = metadataDate(value, "截止日期", metadataClarifications);
          break;
        case "优先级":
          if (["高", "high"].includes(value)) data.priority = "high";
          else if (["普通", "正常", "normal", ""].includes(value)) data.priority = "normal";
          else throw new Error(`第 ${index + 1} 行的优先级不支持“${value}”，请使用“高”或“普通”。`);
          break;
        case "领域":
          if (value) data.area = value;
          break;
        case "备注":
          data.notes = value;
          break;
        case "待确认":
          clarifications.push(...value.split(/[;；]/).map((item) => item.trim()).filter(Boolean));
          break;
        default:
          throw new Error(`第 ${index + 1} 行有不支持的字段“${label}”。支持计划、截止、优先级、领域、备注、待确认。`);
      }
    });
    data.needsClarification = clarifications;
    data.sourceExcerpt = line.slice(0, IMPORT_LIMITS.sourceExcerpt);
    if (line.length > IMPORT_LIMITS.sourceExcerpt) {
      warnings.push(`第 ${index + 1} 行摘录只保留前 ${IMPORT_LIMITS.sourceExcerpt} 字，完整内容保留在原文中。`);
    }
    try {
      tasks.push(annotateTask(taskInputSchema.parse(data), warnings, tasks.length, metadataClarifications));
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error(`第 ${index + 1} 行：${validationErrorMessage(error)}`);
      throw error;
    }
    if (tasks.length > IMPORT_LIMITS.tasks) throw new Error(`一次最多导入 ${IMPORT_LIMITS.tasks} 条任务，请分批导入。`);
  });

  if (!tasks.length) {
    throw new Error(completedLines ? "没有可导入的待办，已完成条目已跳过。" : "没有找到可导入的任务，请填写至少一条任务。");
  }
  if (completedLines) warnings.push(`已跳过 ${completedLines} 条明确标记为已完成的内容。`);
  if (headings) warnings.push(`已跳过 ${headings} 行 Markdown 标题或分隔线。`);
  if (ordinaryLines) warnings.push(`有 ${ordinaryLines} 行普通文本按原文导入，未使用 AI 拆解，请确认它们是待办事项。`);
  summarizeWarnings(tasks, warnings);
  return { sourceText: input, tasks, warnings };
}

export function parseImport(input: string): ImportDraft {
  if (typeof input !== "string") throw new Error("请输入文本或 JSON 内容。");
  if (input.length > IMPORT_LIMITS.input) throw new Error(`导入内容不能超过 ${IMPORT_LIMITS.input} 字。`);
  const content = unwrapFence(input.trim());
  if (!content) throw new Error("请先粘贴要导入的内容。");
  try {
    const isJSON = /^[\[{]/.test(content) && !/^\[[ xX]\]\s*/.test(content);
    return isJSON ? parseJSON(content) : parseText(content);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(validationErrorMessage(error));
    throw error;
  }
}
