import { optionalSnapshot } from "./snapshot-audit";
import { readFile } from "node:fs/promises";
import { expect, test as base, type Page } from "@playwright/test";
import type { LifeData, LifeObservation, LifeThread } from "../lib/life";
import type { Area, WorkspaceData } from "../lib/types";

const STORAGE_KEY = "life-workbench-preview-v1";
type StoredWorkspace = WorkspaceData & { version: 1; life: LifeData };

const test = base.extend<{ audit: void }>({
  audit: [async ({ page, context }, use) => {
    const apiCalls: string[] = [];
    const externalCalls: string[] = [];
    const pageErrors: string[] = [];
    const failedResources: string[] = [];
    const watched = new Set<Page>();
    const watch = (target: Page) => {
      if (watched.has(target)) return;
      watched.add(target);
      target.on("pageerror", error => pageErrors.push(error.message));
      target.on("console", message => { if (message.type() === "error" && !(optionalSnapshot(message.location().url) && /Failed to load resource/.test(message.text()))) pageErrors.push(message.text()); });
      target.on("request", request => {
        const url = new URL(request.url());
        if (!["http:", "https:"].includes(url.protocol)) return;
        if (/(?:^|\/)api(?:\/|$)/.test(url.pathname)) apiCalls.push(`${request.method()} ${url.pathname}`);
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalCalls.push(url.origin);
      });
      target.on("response", response => { if (response.status() >= 400 && !(response.status() === 404 && optionalSnapshot(response.url()))) failedResources.push(`${response.status()} ${response.url()}`); });
      target.on("requestfailed", request => { if (!(optionalSnapshot(request.url()) && request.failure()?.errorText === "net::ERR_ABORTED")) failedResources.push(`${request.failure()?.errorText} ${request.url()}`); });
    };
    watch(page);
    context.on("page", watch);
    await use();
    expect(apiCalls, "人生板在静态版中仅保存到当前浏览器，不调用后台 API").toEqual([]);
    expect(externalCalls, "人生板不需要外部服务或密钥").toEqual([]);
    expect(pageErrors, "人生板交互不得产生未处理的页面错误").toEqual([]);
    expect(failedResources, "静态资源均应成功加载").toEqual([]);
  }, { auto: true }],
});

async function persisted(page: Page): Promise<StoredWorkspace | null> {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, STORAGE_KEY);
}

async function rawStorage(page: Page): Promise<string | null> {
  return page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
}

async function openBoard(page: Page) {
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^人生看板/ })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".life-board")).toBeVisible();
}

async function expectNoTasks(page: Page) {
  const state = await persisted(page);
  expect(state?.tasks ?? []).toEqual([]);
  expect(state?.sources ?? []).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width);
}

async function createThread(page: Page, title: string, options: { area?: Area; kind?: LifeThread["kind"]; description?: string } = {}) {
  await page.getByRole("button", { name: "新增线索", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("线索的名字", { exact: true }).fill(title);
  await dialog.getByLabel(/^这是一条怎样的线索？/).selectOption(options.kind ?? "interest");
  await dialog.getByLabel(/^生活领域/).selectOption(options.area ?? "生活");
  await dialog.getByRole("textbox", { name: /^想留给它的话/ }).fill(options.description ?? "");
  await dialog.getByRole("button", { name: "保存线索", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await persisted(page);
  const thread = saved?.life.board.threads.find(item => item.title === title);
  expect(thread).toBeDefined();
  return thread!;
}

async function createObservation(page: Page, text: string, options: { kind?: LifeObservation["kind"]; date?: string; threadTitle?: string } = {}) {
  if (options.threadTitle) await page.getByRole("button", { name: `为线索留下记录：${options.threadTitle}`, exact: true }).click();
  else await page.locator(".life-board-intro").getByRole("button", { name: "留下一段记录", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^记录的是什么？/).selectOption(options.kind ?? "experience");
  await dialog.getByLabel("发生的日期", { exact: true }).fill(options.date ?? "2026-10-01");
  await dialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true }).fill(text);
  await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function createReview(page: Page, title: string, answers: { noticed: string; changed: string; keep: string }, date = "2026-10-04") {
  await page.getByRole("button", { name: "写一次回顾", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("这次回顾的名字", { exact: true }).fill(title);
  await dialog.getByLabel("回顾日期", { exact: true }).fill(date);
  await dialog.getByRole("textbox", { name: "我注意到了什么？", exact: true }).fill(answers.noticed);
  await dialog.getByRole("textbox", { name: "什么正在变化？", exact: true }).fill(answers.changed);
  await dialog.getByRole("textbox", { name: "我愿意继续保留什么？", exact: true }).fill(answers.keep);
  await dialog.getByRole("button", { name: "保存回顾", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("首页以人生看板开始，主导航区分阅读、影音、思考与事务，浏览不会创建待办", async ({ page }) => {
  await openBoard(page);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("button")).toHaveCount(5);
  for (const name of ["人生看板", "阅读", "影音", "思考", "事务"]) {
    await expect(navigation.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "收集待办", exact: true })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: /待办概览|今天还没有安排/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "事务视图" })).not.toBeVisible();
  expect(await rawStorage(page)).toBeNull();

  await navigation.getByRole("button", { name: /^事务/ }).click();
  const taskNavigation = page.getByRole("navigation", { name: "事务视图" });
  await expect(taskNavigation.getByRole("button")).toHaveCount(4);
  for (const name of ["今天", "收件箱", "全部待办", "已完成"]) {
    await expect(taskNavigation.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await navigation.getByRole("button", { name: /^人生看板/ }).click();
  await expect(page.locator(".life-board")).toBeVisible();
  await expectNoTasks(page);
  expect(await rawStorage(page)).toBeNull();
});

test("生活线索可编辑、暂放、归档与重新关注，独立记录和回顾保留经历而不生成待办", async ({ page }) => {
  test.setTimeout(60_000);
  await openBoard(page);
  const originalTitle = "重新认识自己的阅读兴趣";
  const title = "阅读让我慢慢认识自己";
  const thread = await createThread(page, originalTitle, { area: "阅读", description: "留意我为什么喜欢一本书，不要求读书产生行动。" });
  const card = page.locator(".life-thread-card").filter({ has: page.getByRole("heading", { name: originalTitle, exact: true }) });
  await expect(card).toContainText("兴趣");
  await expect(card).toContainText("正在关注");
  await page.getByRole("button", { name: `编辑线索：${originalTitle}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("线索的名字", { exact: true }).fill(title);
  await dialog.getByRole("textbox", { name: /^想留给它的话/ }).fill("慢慢发现阅读与自己的经历有什么联系。\n允许好奇心暂时没有答案。");
  await dialog.getByRole("button", { name: "保存线索", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await persisted(page))?.life.board.threads).toHaveLength(1);
  expect((await persisted(page))?.life.board.threads[0]).toMatchObject({ id: thread.id, title, kind: "interest", area: "阅读" });

  await page.getByLabel(/^生活领域/).selectOption("健康");
  await expect(page.getByRole("heading", { name: title, exact: true })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "这里暂时没有匹配的线索", exact: true })).toBeVisible();
  await page.getByLabel(/^生活领域/).selectOption("阅读");
  await page.getByRole("button", { name: `暂时放下：${title}`, exact: true }).click();
  await expect(page.locator(".life-thread-card")).toContainText("暂时放下");
  expect((await persisted(page))?.life.board.threads[0].state).toBe("resting");
  await page.getByLabel(/^线索状态/).selectOption("active");
  await expect(page.getByRole("heading", { name: title, exact: true })).not.toBeVisible();
  await page.getByLabel(/^线索状态/).selectOption("resting");
  await page.getByRole("button", { name: `归档线索：${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).not.toBeVisible();
  expect((await persisted(page))?.life.board.threads[0].state).toBe("archived");
  await page.getByLabel(/^线索状态/).selectOption("archived");
  await page.getByRole("button", { name: `重新关注：${title}`, exact: true }).click();
  await page.getByLabel(/^线索状态/).selectOption("all");
  await expect(page.locator(".life-thread-card")).toContainText("正在关注");
  expect((await persisted(page))?.life.board.threads[0].state).toBe("active");

  const observations = [
    { kind: "experience" as const, date: "2026-10-01", text: "在地铁里重新读到一段熟悉的文字。\n这一次想起了毕业那年。" },
    { kind: "feeling" as const, date: "2026-10-02", text: "没有读完也很满足，安静地停留在书里让我放松。" },
    { kind: "discovery" as const, date: "2026-10-03", text: "我喜欢的并不只是题材，而是人物怎样面对变化。" },
  ];
  for (const observation of observations) await createObservation(page, observation.text, { ...observation, threadTitle: title });
  const answers = { noticed: "人物与自己的经历反复呼应。", changed: "我开始允许一本书慢慢读。", keep: "保留睡前安静阅读的时间。" };
  await createReview(page, "最近一周的阅读与生活", answers);
  const saved = await persisted(page);
  expect(saved?.life.board.observations).toHaveLength(3);
  expect(saved?.life.board.observations.map(item => ({ kind: item.kind, date: item.date, text: item.text, threadId: item.threadId, area: item.area }))).toEqual(observations.map(item => ({ ...item, threadId: thread.id, area: "阅读" })));
  expect(saved?.life.board.reviews).toHaveLength(1);
  expect(saved?.life.board.reviews[0]).toMatchObject({ title: "最近一周的阅读与生活", date: "2026-10-04", ...answers });
  await expectNoTasks(page);
  await expect(page.locator(".life-timeline-item").first()).toContainText("最近一周的阅读与生活");
  await page.getByLabel(/^查看记录/).selectOption("feeling");
  await expect(page.locator(".life-timeline-item")).toHaveCount(1);
  await expect(page.locator(".life-timeline-item")).toContainText(observations[1].text);
  await page.getByLabel(/^查看记录/).selectOption("all");

  await page.reload();
  await expect(page.locator(".life-thread-card")).toContainText(title);
  await expect(page.locator(".life-timeline-item")).toHaveCount(4);
  expect((await persisted(page))?.life.board).toEqual(saved?.life.board);
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("button", { name: `删除线索：${title}`, exact: true }).click();
  await expect(page.locator(".life-thread-card")).toHaveCount(0);
  await expect(page.locator(".life-timeline-meta").getByText("原线索已移除", { exact: true })).toHaveCount(3);
  const afterDeletion = await persisted(page);
  expect(afterDeletion?.life.board.threads).toEqual([]);
  expect(afterDeletion?.life.board.observations).toEqual(saved?.life.board.observations);
  expect(afterDeletion?.life.board.reviews).toEqual(saved?.life.board.reviews);
  await page.getByRole("button", { name: "编辑经历：2026-10-01", exact: true }).click();
  await expect(dialog.getByLabel(/^关联线索（可选）/)).toHaveValue(thread.id);
  await expect(dialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true })).toHaveValue(observations[0].text);
  await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await persisted(page))?.life.board.observations).toEqual(saved?.life.board.observations);
  await expectNoTasks(page);
});

test("人生线索、记录和回顾包含在完整备份里，清空后可恢复且重复恢复不新增记录", async ({ page }) => {
  test.setTimeout(60_000);
  await openBoard(page);
  await createThread(page, "与家人保持自在的联系", { area: "关系", kind: "concern", description: "关系的变化值得记住。" });
  await createObservation(page, "和家人聊了一晚旧事，发现彼此的记忆不一样。", { threadTitle: "与家人保持自在的联系", date: "2026-09-30" });
  await createReview(page, "九月末的一次回看", { noticed: "愿意倾听的时候，谈话变得轻松了。", changed: "", keep: "" }, "2026-09-30");
  const before = await persisted(page);
  expect(before).not.toBeNull();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出备份", exact: true }).click();
  const download = await downloadPromise;
  const filename = await download.path();
  expect(filename).not.toBeNull();
  const backup = JSON.parse(await readFile(filename!, "utf8")) as WorkspaceData & { format: string; version: number; life: LifeData };
  expect(backup).toMatchObject({ format: "life-workbench-backup", version: 2 });
  expect(backup.life).toEqual(before?.life);
  expect(backup.tasks).toEqual([]);
  expect(backup.sources).toEqual([]);
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("button", { name: "清空浏览器数据", exact: true }).click();
  await expect(page.locator(".feedback")).toContainText("生活记录、阅读、影音、思考、待办、原文和海报缓存已清空");
  await expect(page.locator(".life-thread-card")).toHaveCount(0);
  await expect(page.locator(".life-timeline-item")).toHaveCount(0);
  expect(await rawStorage(page)).toBeNull();
  await page.reload();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByLabel("选择完整备份文件", { exact: true }).setInputFiles(filename!);
    await expect(page.locator(".feedback")).toContainText("备份已恢复");
    expect((await persisted(page))?.life).toEqual(before?.life);
    await expect(page.locator(".life-thread-card")).toHaveCount(1);
    await expect(page.locator(".life-timeline-item")).toHaveCount(2);
    await expectNoTasks(page);
    await page.locator(".feedback").getByRole("button", { name: "关闭提示", exact: true }).click();
  }
});

test("390px 手机可以保存与回看长文字，线索、记录、回顾和对话框没有横向溢出", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openBoard(page);
  await expectNoHorizontalOverflow(page);
  const title = `长期关心的生活线索${"abcdefghij".repeat(17)}`;
  const description = `给以后回看的自己：\n${"时间和感受不必急着变成行动。".repeat(130)}\n${"unbroken_text_".repeat(100)}`;
  await page.getByRole("button", { name: "新增线索", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("线索的名字", { exact: true }).fill(title);
  await dialog.getByRole("textbox", { name: /^想留给它的话/ }).fill(description);
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "保存线索", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expectNoHorizontalOverflow(page);
  const text = `留在这里的感受：\n${"我注意到自己的变化很慢，但仍然能够回看。".repeat(120)}\n${"a".repeat(1500)}`;
  await page.getByRole("button", { name: `为线索留下记录：${title}`, exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^记录的是什么？/).selectOption("feeling");
  await dialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true }).fill(text);
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "写一次回顾", exact: true }).click();
  dialog = page.getByRole("dialog");
  const reviewTitle = `这一段时间的回顾${"z".repeat(170)}`;
  const noticed = `重新读到自己的记录，${"b".repeat(3500)}`;
  await dialog.getByLabel("这次回顾的名字", { exact: true }).fill(reviewTitle);
  await dialog.getByRole("textbox", { name: "我注意到了什么？", exact: true }).fill(noticed);
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "保存回顾", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expectNoHorizontalOverflow(page);
  const before = await persisted(page);
  expect(before?.life.board.threads[0]).toMatchObject({ title, description });
  expect(before?.life.board.observations[0].text).toBe(text);
  expect(before?.life.board.reviews[0]).toMatchObject({ title: reviewTitle, noticed, changed: "", keep: "" });
  await page.reload();
  await expect(page.locator(".life-thread-card")).toHaveCount(1);
  await expect(page.locator(".life-timeline-item")).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
  expect((await persisted(page))?.life.board).toEqual(before?.life.board);
  await expectNoTasks(page);
  await page.screenshot({ path: "/tmp/life-board-mobile-long-text.png", fullPage: true });
});

test("本地空间不足时旧记录不变、草稿仍可编辑，恢复存储后可重试保存", async ({ page }) => {
  await openBoard(page);
  const thread = await createThread(page, "保留原来的生活记录", { area: "健康", description: "这段内容必须在保存失败时保持不变。" });
  const before = await rawStorage(page);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    const taskWindow = window as typeof window & { lifeBoardQuotaExceeded?: boolean };
    taskWindow.lifeBoardQuotaExceeded = true;
    Storage.prototype.setItem = function (storageKey: string, value: string) {
      if (storageKey === key && taskWindow.lifeBoardQuotaExceeded) throw new DOMException("Synthetic test quota", "QuotaExceededError");
      return original.call(this, storageKey, value);
    };
  }, STORAGE_KEY);
  await page.getByRole("button", { name: `为线索留下记录：${thread.title}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  const draft = "今天感到疲惫，我想先记下这种感受。\n不急着解释，也不把它变成任务。";
  await dialog.getByLabel(/^记录的是什么？/).selectOption("feeling");
  await dialog.getByLabel("发生的日期", { exact: true }).fill("2026-10-05");
  await dialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true }).fill(draft);
  await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("本地存储空间不足");
  await expect(dialog.getByRole("alert")).toContainText("草稿仍保留在这里");
  await expect(dialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true })).toHaveValue(draft);
  await expect(dialog.getByLabel(/^关联线索（可选）/)).toHaveValue(thread.id);
  await expect(dialog.getByRole("button", { name: "保存记录", exact: true })).toBeEnabled();
  expect(await rawStorage(page)).toBe(before);
  expect((await persisted(page))?.life.board.observations).toEqual([]);
  const correctedDraft = `${draft}\n之后回看时，希望温和一点。`;
  await dialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true }).fill(correctedDraft);
  await page.evaluate(() => { (window as typeof window & { lifeBoardQuotaExceeded?: boolean }).lifeBoardQuotaExceeded = false; });
  await dialog.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const after = await persisted(page);
  expect(after?.life.board.threads).toEqual([thread]);
  expect(after?.life.board.observations).toHaveLength(1);
  expect(after?.life.board.observations[0]).toMatchObject({ text: correctedDraft, threadId: thread.id, kind: "feeling", date: "2026-10-05", area: "健康" });
  await expectNoTasks(page);
  await page.reload();
  await expect(page.locator(".life-timeline-content")).toContainText(correctedDraft);
  expect((await persisted(page))?.life.board).toEqual(after?.life.board);
});

test("两个标签页分别保存经历与思考时互相保留，旧看板修改遭拒绝并保留草稿", async ({ page, context }) => {
  test.setTimeout(60_000);
  await openBoard(page);
  const otherPage = await context.newPage();
  try {
    await openBoard(otherPage);
    expect(await rawStorage(page)).toBeNull();
    expect(await rawStorage(otherPage)).toBeNull();
    await page.locator(".life-board-intro").getByRole("button", { name: "留下一段记录", exact: true }).click();
    const boardDialog = page.getByRole("dialog");
    const experience = "周末走了一条从未走过的街，发现熟悉的城市还有很多陌生的角落。";
    await boardDialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true }).fill(experience);
    await boardDialog.getByLabel("发生的日期", { exact: true }).fill("2026-10-06");
    await otherPage.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^思考/ }).click();
    await otherPage.getByRole("button", { name: "新建思考", exact: true }).click();
    const thoughtTitle = "给没有答案的好奇心一点空间";
    const thoughtBody = "想法可以独立留在这里，不一定马上安排成要做的事。";
    await otherPage.getByLabel("思考标题", { exact: true }).fill(thoughtTitle);
    await otherPage.getByRole("textbox", { name: "我的想法", exact: true }).fill(thoughtBody);
    await Promise.all([
      boardDialog.getByRole("button", { name: "保存记录", exact: true }).click(),
      otherPage.getByRole("button", { name: "保存思考", exact: true }).click(),
    ]);
    await expect(boardDialog).not.toBeVisible();
    await expect(otherPage.getByRole("article", { name: thoughtTitle, exact: true })).toBeVisible();
    // Each renderer sees another tab's localStorage change asynchronously.
    // Wait for both confirmed saves to be visible before taking the snapshot;
    // a lost write will still fail this assertion.
    await expect.poll(async () => (await persisted(page))?.life.thoughts.length).toBe(1);
    const saved = await persisted(page);
    expect(saved?.life.board.observations).toHaveLength(1);
    expect(saved?.life.board.observations[0]).toMatchObject({ text: experience, date: "2026-10-06", kind: "experience" });
    expect(saved?.life.thoughts).toHaveLength(1);
    expect(saved?.life.thoughts[0]).toMatchObject({ title: thoughtTitle, body: thoughtBody });
    await expectNoTasks(page);
    expect((await persisted(otherPage))?.life).toEqual(saved?.life);

    await page.locator(".life-board-intro").getByRole("button", { name: "留下一段记录", exact: true }).click();
    const unsaved = "我仍想留下这段感受，即使另一个页面已经改了看板。";
    await boardDialog.getByLabel(/^记录的是什么？/).selectOption("feeling");
    await boardDialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true }).fill(unsaved);
    await otherPage.reload();
    await expect(otherPage.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
    const newThread = await createThread(otherPage, "继续探索城市里的日常生活", { area: "出行", kind: "interest" });
    const beforeRejectedSave = await rawStorage(page);
    await boardDialog.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(boardDialog.getByRole("alert")).toContainText("另一个页面更新");
    await expect(boardDialog.getByRole("alert")).toContainText("草稿已保留");
    await expect(boardDialog.getByRole("textbox", { name: "留下这段经历、感受或发现", exact: true })).toHaveValue(unsaved);
    await expect(boardDialog.getByRole("button", { name: "保存记录", exact: true })).toBeEnabled();
    expect(await rawStorage(page)).toBe(beforeRejectedSave);
    const after = await persisted(page);
    expect(after?.life.board.threads).toEqual([newThread]);
    expect(after?.life.board.observations).toEqual(saved?.life.board.observations);
    expect(after?.life.thoughts).toEqual(saved?.life.thoughts);
    await expectNoTasks(page);
  } finally { await otherPage.close(); }
});
