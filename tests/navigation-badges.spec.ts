import { expect } from "@playwright/test";
import { test, writePreviewWorkspace } from "./preview-fixtures";
import { emptyLifeData } from "../lib/life";
import type { Task } from "../lib/types";

test("手机底栏只提醒未完成事务，胶囊与图标、文字和相邻入口保持分离", async ({ page }) => {
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: { version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-10-10T00:00:00Z", entries: [] } }));
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.locator(".nav-pending-badge")).toHaveCount(0);
  const life = emptyLifeData();
  life.reading.books = Array.from({ length: 395 }, (_, index) => ({ id: `badge-test-book-${index}`, title: `合成书籍 ${index}`, author: "测试作者", kind: "ebook", status: "reading" }));
  const makeTask = (index: number, done: boolean): Task => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, sourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: `合成事务 ${index}`, notes: "", area: "生活", priority: "normal", plannedDate: null, dueDate: null, needsClarification: [], sourceExcerpt: "", status: done ? "done" : "todo", createdAt: "2026-10-10T00:00:00Z", completedAt: done ? "2026-10-10T00:00:00Z" : null });
  for (const count of [1, 12, 131]) {
    await writePreviewWorkspace(page, { version: 1, tasks: [...Array.from({ length: count }, (_, index) => makeTask(index, false)), makeTask(count, true)], sources: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", text: "合成测试资料", createdAt: "2026-10-10T00:00:00Z" }], batches: {}, life });
    await page.reload();
    await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
    const tasks = navigation.getByRole("button", { name: "事务", exact: true });
    await expect(tasks).toHaveAccessibleDescription(`${count} 项未完成事务`);
    const badge = tasks.locator(".nav-pending-badge");
    await expect(badge).toHaveText(count > 99 ? "99+" : String(count));
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(badge).toBeVisible();
      await expect(navigation.locator(".nav-total").first()).not.toBeVisible();
      const bounds = await navigation.evaluate(nav => {
        const buttons = [...nav.querySelectorAll("button")];
        const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const task = buttons.at(-1)!;
        return { buttons: buttons.map(rect), icons: buttons.map(button => rect(button.querySelector("svg")!)), task: rect(task), badge: rect(task.querySelector(".nav-pending-badge")!), label: rect(task.querySelector(".nav-label-text")!), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(bounds.overflow).toBe(false);
      for (const [index, button] of bounds.buttons.entries()) {
        expect(button.width).toBeGreaterThanOrEqual(44);
        expect(button.height).toBeGreaterThanOrEqual(44);
        expect(button.left).toBeGreaterThanOrEqual(0);
        expect(button.right).toBeLessThanOrEqual(width);
        if (index) expect(button.left).toBeGreaterThan(bounds.buttons[index - 1].right);
        expect(bounds.icons[index].top).toBeCloseTo(bounds.icons[0].top, 1);
      }
      expect(bounds.badge.left).toBeGreaterThanOrEqual(bounds.label.right + 1);
      expect(bounds.badge.right).toBeLessThanOrEqual(bounds.task.right + .5);
      expect(bounds.badge.top).toBeGreaterThan(bounds.icons.at(-1)!.bottom + 1);
      expect(bounds.badge.bottom).toBeLessThan(bounds.task.bottom);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(badge).not.toBeVisible();
    await expect(navigation.getByRole("button", { name: "阅读", exact: true }).locator(".nav-total")).toHaveText("395");
    await expect(tasks.locator(".nav-total")).toHaveText(String(count));
  }
});

test("手机各页面顶栏保持单行，入口和锁定按钮不会挤出屏幕", async ({ page }) => {
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: { version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-10-10T00:00:00Z", entries: [] } }));
  await page.goto("./");
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  const navigation = page.getByRole("navigation", { name: "主导航" });
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["人生看板", "阅读", "影音", "思考", "财务", "事务"]) {
      await navigation.getByRole("button", { name, exact: true }).click();
      const layout = await page.locator(".topbar").evaluate(header => {
        const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
        const crumb = header.querySelector(".breadcrumb")!;
        const date = header.querySelector(".date-label")!;
        const textLines = (element: Element) => [...element.childNodes].flatMap(node => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
          const range = document.createRange(); range.selectNodeContents(node);
          return [...range.getClientRects()].filter(r => r.height > 0 && r.width > 0);
        }).length;
        return { crumb: rect(crumb), date: rect(date), titleLines: textLines(crumb.querySelector("strong")!), dateLines: textLines(date), lock: rect(header.querySelector(".workspace-lock-button")!), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(layout.overflow).toBe(false);
      expect(layout.crumb.height).toBeLessThanOrEqual(40);
      expect(layout.titleLines).toBe(1);
      expect(layout.dateLines).toBe(1);
      expect(layout.crumb.right).toBeLessThanOrEqual(layout.date.left);
      expect(layout.lock.right).toBeLessThanOrEqual(width);
      expect(layout.lock.width).toBeGreaterThanOrEqual(44);
      expect(layout.lock.height).toBeGreaterThanOrEqual(44);
    }
  }
});
