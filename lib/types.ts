export const AREAS = ["生活", "工作", "健康", "阅读", "出行", "思考", "其他"] as const;
export type Area = (typeof AREAS)[number];
export type Priority = "normal" | "high";

export interface TaskInput {
  title: string;
  notes: string;
  area: Area;
  priority: Priority;
  plannedDate: string | null;
  dueDate: string | null;
  needsClarification: string[];
  sourceExcerpt: string;
}

export interface Task extends TaskInput {
  id: string;
  status: "todo" | "done";
  sourceId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface SourceRecord {
  id: string;
  text: string;
  createdAt: string;
}

export interface WorkspaceData {
  tasks: Task[];
  sources: SourceRecord[];
}

export interface ImportDraft {
  sourceText: string;
  tasks: TaskInput[];
  warnings: string[];
}
