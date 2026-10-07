import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { WorkspaceData } from "../lib/types";

async function snapshot(request: APIRequestContext): Promise<WorkspaceData> {
  const response = await request.get("/api/tasks");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<WorkspaceData>;
}

async function selectView(page: Page, name: string) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
}

test("聊天整理结果经过预览确认后保存，刷新、完成、编辑与备份恢复均保留数据", async ({ page, request }) => {
  test.setTimeout(90_000);
  const sourceText = "测试原话：把抽屉整理一下，另一个想法是买一个新书架，书架先不要安排。";
  const originalTitle = "整理抽屉";
  const confirmedTitle = "整理书桌抽屉并归档票据";
  const excludedTitle = "购买新书架";
  let taskId: string | undefined;

  try {
    await test.step("新环境为空，粘贴与预览尚不写入数据库", async () => {
      expect(await snapshot(request)).toEqual({ tasks: [], sources: [] });
      await page.goto("/");
      await expect(page.getByRole("button", { name: "收集待办", exact: true })).toBeEnabled();
      await expect(page.getByRole("heading", { name: "今天还没有安排" })).toBeVisible();
      await page.screenshot({ path: "/tmp/life-desktop.png", fullPage: true });
      await selectView(page, "收件箱");
      await page.getByRole("button", { name: "收集待办", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("聊天整理结果").fill(JSON.stringify({
        version: 1,
        sourceText,
        tasks: [
          { title: originalTitle, area: "生活", notes: "先把票据放在一起", sourceExcerpt: "把抽屉整理一下" },
          { title: excludedTitle, area: "生活", sourceExcerpt: "买一个新书架，书架先不要安排" },
        ],
      }));
      await dialog.getByRole("button", { name: "生成待办预览" }).click();
      await expect(dialog.getByRole("checkbox", { name: "待办 01" })).toBeChecked();
      await expect(dialog.getByRole("checkbox", { name: "待办 02" })).toBeChecked();
      await dialog.locator("#draft-0-title").fill(confirmedTitle);
      await dialog.getByRole("checkbox", { name: "待办 02" }).uncheck();
      expect(await snapshot(request)).toEqual({ tasks: [], sources: [] });
      await dialog.getByRole("button", { name: "确认保存 1 条" }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole("button", { name: `完成：${confirmedTitle}`, exact: true })).toBeVisible();
      const saved = await snapshot(request);
      expect(saved.tasks).toHaveLength(1);
      expect(saved.sources).toHaveLength(1);
      expect(saved.tasks[0]).toMatchObject({ title: confirmedTitle, status: "todo", sourceExcerpt: "把抽屉整理一下" });
      expect(saved.tasks.some(task => task.title === excludedTitle)).toBe(false);
      expect(saved.sources[0].text).toBe(sourceText);
      expect(saved.tasks[0].sourceId).toBe(saved.sources[0].id);
      taskId = saved.tasks[0].id;
    });

    await test.step("刷新后保留，完成和撤销完成可往返", async () => {
      await page.reload();
      await expect(page.getByRole("button", { name: "收集待办", exact: true })).toBeEnabled();
      await selectView(page, "全部待办");
      await expect(page.getByRole("button", { name: `完成：${confirmedTitle}`, exact: true })).toBeVisible();
      await page.getByRole("button", { name: `完成：${confirmedTitle}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `完成：${confirmedTitle}`, exact: true })).not.toBeVisible();
      let saved = await snapshot(request);
      expect(saved.tasks[0].status).toBe("done");
      expect(saved.tasks[0].completedAt).not.toBeNull();
      await selectView(page, "已完成");
      await page.getByRole("button", { name: `撤销完成：${confirmedTitle}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `撤销完成：${confirmedTitle}`, exact: true })).not.toBeVisible();
      saved = await snapshot(request);
      expect(saved.tasks[0].status).toBe("todo");
      expect(saved.tasks[0].completedAt).toBeNull();
      await selectView(page, "全部待办");
    });

    await test.step("编辑具体日期并显示原文来源", async () => {
      await page.getByRole("button", { name: `查看详情：${confirmedTitle}`, exact: true }).click();
      await page.getByRole("button", { name: "编辑待办", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("计划日期", { exact: true }).fill("2099-06-15");
      await dialog.getByLabel("截止日期", { exact: true }).fill("2099-06-18");
      await dialog.getByRole("button", { name: "保存待办", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      const saved = await snapshot(request);
      expect(saved.tasks[0]).toMatchObject({ plannedDate: "2099-06-15", dueDate: "2099-06-18", sourceExcerpt: "把抽屉整理一下" });
      await page.locator(".task-details").getByText("查看这批待办的原文", { exact: true }).click();
      await expect(page.locator(".task-details pre")).toHaveText(sourceText);
    });

    await test.step("导出真实下载文件，清空待办后恢复，重复恢复不新增", async () => {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出备份", exact: true }).click();
      const download = await downloadPromise;
      const file = await download.path();
      expect(file).not.toBeNull();
      const backup = JSON.parse(await readFile(file!, "utf8")) as WorkspaceData & { format: string; version: number };
      expect(backup).toMatchObject({ format: "life-workbench-backup", version: 1 });
      expect(backup.tasks).toHaveLength(1);
      expect(backup.tasks[0].id).toBe(taskId);
      expect(backup.sources[0].text).toBe(sourceText);
      const deleted = await request.delete(`/api/tasks/${taskId}`);
      expect(deleted.ok()).toBeTruthy();
      expect(await snapshot(request)).toEqual({ tasks: [], sources: [] });
      await page.reload();
      await expect(page.getByRole("button", { name: "恢复备份", exact: true })).toBeEnabled();
      await page.getByLabel("选择待办备份文件").setInputFiles(file!);
      await expect(page.getByRole("status")).toContainText("备份已恢复");
      const restored = await snapshot(request);
      expect(restored.tasks).toEqual(backup.tasks);
      expect(restored.sources).toEqual(backup.sources);
      const repeated = await request.post("/api/restore", { data: backup });
      expect(repeated.ok()).toBeTruthy();
      expect(await snapshot(request)).toEqual(restored);
      await selectView(page, "全部待办");
      await expect(page.getByRole("button", { name: `完成：${confirmedTitle}`, exact: true })).toBeVisible();
    });
  } finally {
    if (taskId) await request.delete(`/api/tasks/${taskId}`);
  }
});

test("无效日期和跨站提交被拒绝，数据库保持原样", async ({ request }) => {
  const before = await snapshot(request);
  const invalid = await request.post("/api/tasks", { data: {
    batchId: randomUUID(), sourceText: "日期校验测试",
    tasks: [{ title: "不存在的日期不可保存", plannedDate: "2099-02-30" }],
  } });
  expect(invalid.status()).toBe(400);
  expect(await snapshot(request)).toEqual(before);

  const headers = { Origin: "https://untrusted.example", "Content-Type": "application/json" };
  const id = randomUUID();
  const rejected = [
    await request.post("/api/tasks", { headers, data: { batchId: randomUUID(), sourceText: "跨站测试", tasks: [{ title: "不能保存" }] } }),
    await request.patch(`/api/tasks/${id}`, { headers, data: { status: "done" } }),
    await request.delete(`/api/tasks/${id}`, { headers }),
    await request.post("/api/restore", { headers, data: { format: "life-workbench-backup", version: 1, exportedAt: new Date().toISOString(), tasks: [], sources: [] } }),
  ];
  for (const response of rejected) expect(response.status()).toBe(403);
  expect(await snapshot(request)).toEqual(before);
});

test("390 像素手机视口可收集、预览、新建和编辑，没有横向滚动", async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const title = "手机测试：整理玄关的钥匙和雨伞";
  let taskId: string | undefined;
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "收集待办", exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: "/tmp/life-mobile.png", fullPage: true });
    await selectView(page, "收件箱");
    await page.getByRole("button", { name: "收集待办", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("聊天整理结果").fill("- [ ] 检查手机收集入口 | 领域：生活 | 备注：这是一条尚未保存的测试待办");
    await dialog.getByRole("button", { name: "生成待办预览" }).click();
    await expect(dialog.getByRole("checkbox", { name: "待办 01" })).toBeChecked();
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await page.getByRole("button", { name: "新建待办", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("要做什么", { exact: true }).fill(title);
    await dialog.getByRole("combobox", { name: "生活领域", exact: true }).selectOption("生活");
    await dialog.getByRole("button", { name: "保存待办", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: `完成：${title}`, exact: true })).toBeVisible();
    const saved = await snapshot(request);
    taskId = saved.tasks.find(task => task.title === title)?.id;
    expect(taskId).toBeTruthy();
    await page.getByRole("button", { name: `查看详情：${title}`, exact: true }).click();
    await page.getByRole("button", { name: "编辑待办", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("备注", { exact: true }).fill("放进玄关的收纳盒");
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "保存待办", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await snapshot(request)).tasks.find(task => task.id === taskId)?.notes).toBe("放进玄关的收纳盒");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: "/tmp/life-mobile-with-task.png", fullPage: true });
  } finally {
    if (taskId) await request.delete(`/api/tasks/${taskId}`);
  }
});
