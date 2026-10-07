import { describe, expect, it } from "vitest";
import { parseImport } from "./import";
import { dateSchema, importBatchSchema, taskInputSchema, taskPatchSchema } from "./validation";

function jsonImport(tasks: unknown[], sourceText = "聊天整理的原文") {
  return JSON.stringify({ version: 1, sourceText, tasks });
}

describe("日期与严格字段验证", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-10-07", "0001-01-01"])("接受真实日期 %s", (date) => {
    expect(dateSchema.parse(date)).toBe(date);
  });

  it.each([
    "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-13-10",
    "2026-01-00", "0000-01-01", "2026-1-7", "2026-10-07T00:00:00Z", "明天", "2026-02-30",
  ])("拒绝不存在或含歧义的日期 %s", (date) => {
    expect(dateSchema.safeParse(date).success).toBe(false);
  });

  it("空日期是 null，patch 不给遗漏字段填默认值", () => {
    expect(dateSchema.parse("   ")).toBeNull();
    expect(dateSchema.parse(null)).toBeNull();
    expect(taskInputSchema.parse({ title: "  买菜  ", dueDate: "" })).toEqual({
      title: "买菜", notes: "", area: "生活", priority: "normal", plannedDate: null,
      dueDate: null, needsClarification: [], sourceExcerpt: "",
    });
    expect(taskPatchSchema.parse({ status: "done" })).toEqual({ status: "done" });
    expect(taskPatchSchema.parse({ dueDate: "" })).toEqual({ dueDate: null });
  });

  it("拒绝未知字段、领域和不允许的内部状态", () => {
    expect(taskInputSchema.safeParse({ title: "买菜", area: "运动" }).success).toBe(false);
    expect(taskInputSchema.safeParse({ title: "买菜", hidden: true }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ id: "other-user-task", status: "done" }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ status: "archived" }).success).toBe(false);
    expect(taskInputSchema.safeParse({ title: "买菜", status: "done" }).success).toBe(false);
  });

  it("批次要求 UUID、非空任务，且支持任务默认值", () => {
    const batch = {
      batchId: "47d3e0db-74c5-4b0f-8f18-cf34ae0f6116",
      sourceText: "买菜", tasks: [{ title: "买菜" }],
    };
    expect(importBatchSchema.parse(batch).tasks[0].plannedDate).toBeNull();
    expect(importBatchSchema.safeParse({ ...batch, batchId: "invalid" }).success).toBe(false);
    expect(importBatchSchema.safeParse({ ...batch, tasks: [] }).success).toBe(false);
    expect(importBatchSchema.safeParse({ ...batch, userId: "someone" }).success).toBe(false);
  });
});

describe("聊天 JSON 导入", () => {
  it("保留原文与给定日期，填充部分任务字段", () => {
    const draft = parseImport(jsonImport([{ title: "预约洗牙", area: "健康", dueDate: "2026-10-09" }], "我想检查牙齿。"));
    expect(draft.sourceText).toBe("我想检查牙齿。");
    expect(draft.tasks[0]).toMatchObject({
      title: "预约洗牙", notes: "", area: "健康", priority: "normal", dueDate: "2026-10-09",
      plannedDate: null, needsClarification: [], sourceExcerpt: "",
    });
  });

  it("支持从聊天直接复制完整 JSON 代码块", () => {
    expect(parseImport(`\`\`\`json\n${jsonImport([{ title: "收拾书桌" }])}\n\`\`\``).tasks[0].title).toBe("收拾书桌");
  });

  it("不会默默把未知字段或错误版本扔掉", () => {
    expect(() => parseImport(JSON.stringify({ version: 2, sourceText: "", tasks: [{ title: "买菜" }] }))).toThrow("版本必须是 1");
    expect(() => parseImport(jsonImport([{ title: "买菜", labels: ["生活"] }]))).toThrow("不支持的字段：labels");
    expect(() => parseImport(jsonImport([{ title: "买菜", area: "购物" }]))).toThrow("领域必须是");
    expect(() => parseImport(jsonImport([{ title: "买菜", dueDate: "2026-02-30" }]))).toThrow("实际存在");
    expect(() => parseImport("{\"version\":1," )).toThrow("JSON 格式有误");
  });

  it("同名条目全部保留并提示复核", () => {
    const draft = parseImport(jsonImport([{ title: "买菜" }, { title: " 买菜 " }]));
    expect(draft.tasks).toHaveLength(2);
    expect(draft.warnings.some((warning) => warning.includes("已保留") && warning.includes("第 2 条"))).toBe(true);
  });

  it("待确认说明已满时保留用户全部内容，将新生成提示单独显示", () => {
    const needsClarification = Array.from({ length: 10 }, (_, index) => `用户待确认 ${index + 1}`);
    const sourceText = "明天开始每周跑步，需要确认十个细节。";
    const draft = parseImport(jsonImport([{ title: "明天开始每周跑步", needsClarification }], sourceText));
    expect(draft.tasks[0].needsClarification).toEqual(needsClarification);
    expect(draft.tasks[0].plannedDate).toBeNull();
    expect(draft.sourceText).toBe(sourceText);
    expect(draft.warnings.join(" ")).toContain("相对日期");
    expect(draft.warnings.join(" ")).toContain("周期安排");
    expect(draft.warnings.join(" ")).toContain("原有待确认说明已全部保留");
  });

  it("剩余一条待确认容量时添加一条提示，另一条保留在告警中", () => {
    const needsClarification = Array.from({ length: 9 }, (_, index) => `确认细节 ${index}`);
    const draft = parseImport(jsonImport([{ title: "明天开始每周跑步", needsClarification }]));
    expect(draft.tasks[0].needsClarification.slice(0, 9)).toEqual(needsClarification);
    expect(draft.tasks[0].needsClarification).toHaveLength(10);
    expect(draft.tasks[0].needsClarification[9]).toContain("相对日期");
    expect(draft.warnings.join(" ")).toContain("周期安排");
  });

  it("明确限制总输入、原文、条目和字段长度", () => {
    expect(parseImport(jsonImport(Array.from({ length: 100 }, (_, index) => ({ title: `事项 ${index}` })))).tasks).toHaveLength(100);
    expect(() => parseImport(jsonImport(Array.from({ length: 101 }, (_, index) => ({ title: `事项 ${index}` }))))).toThrow("100 条");
    expect(() => parseImport(jsonImport([{ title: "买菜" }], "文".repeat(20_001)))).toThrow("20000 字");
    expect(() => parseImport("文".repeat(100_001))).toThrow("100000 字");
    expect(() => parseImport(jsonImport([{ title: "题".repeat(301) }]))).toThrow("300 字");
    expect(() => parseImport(jsonImport([{ title: "买菜", notes: "文".repeat(5_001) }]))).toThrow("5000 字");
    expect(() => parseImport(jsonImport([{ title: "买菜", needsClarification: ["问".repeat(501)] }]))).toThrow("500 字");
    expect(() => parseImport(jsonImport([{ title: "买菜", sourceExcerpt: "文".repeat(2_001) }]))).toThrow("2000 字");
  });
});

describe("Markdown 与普通文本导入", () => {
  it("解析字段，同时支持勾选列表和编号", () => {
    const draft = parseImport("- [ ] 准备项目演示 | 计划:2026-10-08 | 截止:2026-10-09 | 优先级:高 | 领域:工作 | 备注:带演示材料 | 待确认:确认地点；确认人数\n2. 买菜");
    expect(draft.tasks).toHaveLength(2);
    expect(draft.tasks[0]).toMatchObject({
      title: "准备项目演示", plannedDate: "2026-10-08", dueDate: "2026-10-09", priority: "high",
      area: "工作", notes: "带演示材料", needsClarification: ["确认地点", "确认人数"],
    });
    expect(draft.tasks[1].title).toBe("买菜");
  });

  it("跳过已完成行和标题，保留未完成行且不新增任务", () => {
    const draft = parseImport("# 本周事项\n- [x] 洗过衣服\n2. [X] 买好牛奶\n已完成：缴费\n- [ ] 买鸡蛋\n[ ] 预约理发");
    expect(draft.tasks.map((task) => task.title)).toEqual(["买鸡蛋", "预约理发"]);
    expect(draft.warnings.some((warning) => warning.includes("跳过 3 条"))).toBe(true);
    expect(() => parseImport("- [x] 已经做完的事情")).toThrow("已完成条目已跳过");
  });

  it("单独的 [ ] 起始内容不会误当成 JSON 数组", () => {
    expect(parseImport("[ ] 预约理发").tasks[0].title).toBe("预约理发");
    expect(() => parseImport("[x] 完成的事情")).toThrow("已完成条目已跳过");
  });

  it("相对日期和周期只标记待确认，不自行分配日期或重复任务", () => {
    const draft = parseImport("明天买菜\n每周一跑步\n预约洗牙 | 计划:下周\n保留 2026-10-08 版资料");
    expect(draft.tasks).toHaveLength(4);
    for (const task of draft.tasks) {
      expect(task.plannedDate).toBeNull();
      expect(task.dueDate).toBeNull();
    }
    expect(draft.tasks[0].needsClarification.join(" ")).toContain("相对日期");
    expect(draft.tasks[1].needsClarification.join(" ")).toContain("周期安排");
    expect(draft.tasks[2].needsClarification.join(" ")).toContain("未自动换算");
    expect(draft.tasks[3].needsClarification).toEqual([]);
    expect(draft.tasks[3].title).toBe("保留 2026-10-08 版资料");
  });

  it("普通叙述仅按行导入，不从一段话虚构多个动作", () => {
    const input = "整理一下卧室，顺便看看是否要买收纳盒\n考虑下一步职业方向";
    const draft = parseImport(input);
    expect(draft.sourceText).toBe(input);
    expect(draft.tasks.map((task) => task.title)).toEqual(input.split("\n"));
    expect(draft.warnings.join(" ")).toContain("未使用 AI 拆解");
  });

  it("Markdown 相对日期提示不占用已满的用户待确认说明", () => {
    const needsClarification = Array.from({ length: 10 }, (_, index) => `细节 ${index + 1}`);
    const input = `预约洗牙 | 计划:下周 | 待确认:${needsClarification.join("；")}`;
    const draft = parseImport(input);
    expect(draft.tasks[0].needsClarification).toEqual(needsClarification);
    expect(draft.tasks[0].plannedDate).toBeNull();
    expect(draft.warnings.join(" ")).toContain("计划日期“下周”");
    expect(draft.sourceText).toBe(input);
  });

  it("日期、字段、重复字段和未知领域错误都有明确反馈", () => {
    expect(() => parseImport("买菜 | 截止:2026-04-31")).toThrow("实际存在");
    expect(() => parseImport("买菜 | 截止:2026-04-31 周五")).toThrow("实际存在");
    expect(() => parseImport("买菜 | 领域:购物")).toThrow("领域必须是");
    expect(() => parseImport("买菜 | 计划:2026-10-08 | 计划:2026-10-09")).toThrow("重复");
    expect(() => parseImport("买菜 | 优先级:最高")).toThrow("优先级不支持");
    expect(() => parseImport("买菜 | 期限:2026-10-09")).toThrow("不支持的字段");
    expect(() => parseImport("- [ ] ")).toThrow("缺少任务标题");
  });

  it("保留文字中的竖线，处理空输入与任务数边界", () => {
    expect(parseImport("阅读 A\\|B 对照笔记 | 领域:阅读").tasks[0].title).toBe("阅读 A|B 对照笔记");
    expect(() => parseImport("   \n ")).toThrow("请先粘贴");
    expect(() => parseImport(Array.from({ length: 101 }, (_, index) => `- [ ] 事项 ${index}`).join("\n"))).toThrow("100 条");
  });

  it("长摘录明确提示截断，完整内容仍在原文中", () => {
    const input = `买菜 | 备注:${"材料".repeat(1_200)}`;
    const draft = parseImport(input);
    expect(draft.tasks[0].sourceExcerpt).toHaveLength(2_000);
    expect(draft.sourceText).toBe(input);
    expect(draft.tasks[0].notes).toHaveLength(2_400);
    expect(draft.warnings.join(" ")).toContain("完整内容保留在原文");
  });
});
