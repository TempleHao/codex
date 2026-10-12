import { expect, test } from "@playwright/test";
import { emptyLifeData } from "../lib/life";

const KEY = "life-workbench-preview-v1";
const PASSWORD = "synthetic-lock-passphrase";
const original = () => {
  const life = emptyLifeData();
  life.thoughts = [{ id: "22222222-2222-4222-8222-222222222222", title: "合成的私人思考", body: "private-synthetic-memory-only", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }];
  return JSON.stringify({ version: 1, tasks: [], sources: [], batches: {}, life });
};

test("首次设置迁移旧记录，刷新和主动锁定后需口令，错误口令不改密文", async ({ page }) => {
  const raw = original();
  await page.addInitScript(({ key, raw }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, raw); }, { key: KEY, raw });
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: { version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-10-09T00:00:00Z", entries: [] } }));
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "设置本机口令", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /记住这台设备/ }).uncheck();
  await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
  await page.getByLabel("本机口令", { exact: true }).fill(PASSWORD);
  await page.getByLabel("再次输入口令").fill("different-passphrase");
  await page.getByRole("button", { name: "设置口令并打开", exact: true }).click();
  await expect(page.locator(".workspace-gate").getByRole("alert")).toContainText("两次输入");
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(raw);
  await page.getByLabel("再次输入口令").fill(PASSWORD);
  await page.getByRole("button", { name: "设置口令并打开", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  const cipher = await page.evaluate(key => localStorage.getItem(key)!, KEY);
  expect(JSON.parse(cipher).format).toBe("life-workbench-encrypted");
  expect(cipher).not.toContain("private-synthetic-memory-only");
  expect(cipher).not.toContain(PASSWORD);

  await page.reload();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /记住这台设备/ })).not.toBeChecked();
  await expect(page.locator(".workspace")).toHaveCount(0);
  await page.getByLabel("本机口令", { exact: true }).fill("wrong-passphrase");
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.locator(".workspace-gate").getByRole("alert")).toContainText("口令不正确");
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
  await page.getByLabel("本机口令", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^思考/ }).click();
  await expect(page.locator(".thoughts-list")).toContainText("private-synthetic-memory-only");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "锁定我的空间", exact: true }).click();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  await expect(page.locator(".thoughts-panel")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
});

test("加密迁移遇到存储配额错误保留旧资料，显示可重试错误", async ({ page }) => {
  const raw = original();
  await page.addInitScript(({ key, raw }) => {
    localStorage.setItem(key, raw);
    const native = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && value.includes('"format":"life-workbench-encrypted"')) throw new DOMException("full", "QuotaExceededError");
      native.call(this, name, value);
    };
  }, { key: KEY, raw });
  await page.goto("./");
  await page.getByLabel("本机口令", { exact: true }).fill(PASSWORD);
  await page.getByLabel("再次输入口令").fill(PASSWORD);
  await page.getByRole("button", { name: "设置口令并打开", exact: true }).click();
  await expect(page.locator(".workspace-gate").getByRole("alert")).toContainText("存储空间不足");
  await expect(page.locator(".workspace")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(raw);
  await expect(page.getByRole("button", { name: "设置口令并打开", exact: true })).toBeEnabled();
});

const DEVICE_DB = "life-workbench-device-trust-v1";
async function trustDetails(page: import("@playwright/test").Page) {
  return page.evaluate(async database => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(database, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      return await new Promise<{ id: string; expiresAt: number; createdAt: number; extractable: boolean; algorithm: string } | null>((resolve, reject) => {
        const tx = db.transaction("trust"); const request = tx.objectStore("trust").get("device");
        tx.oncomplete = () => { const d = request.result?.device; resolve(d ? { id: d.id, expiresAt: d.expiresAt, createdAt: d.createdAt, extractable: d.key.extractable, algorithm: d.key.algorithm.name } : null); }; tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, DEVICE_DB);
}
async function openRemembered(page: import("@playwright/test").Page) {
  await page.route("**/blog-sync.json*", route => route.fulfill({ json: { version: 1, sourceUrl: "https://www.ashsilent.com/", updatedAt: "2026-10-12T00:00:00Z", entries: [] } }));
  await page.goto("./");
  await expect(page.getByRole("checkbox", { name: /记住这台设备/ })).toBeChecked();
  await page.getByLabel("本机口令", { exact: true }).fill(PASSWORD);
  await page.getByLabel("再次输入口令", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "设置口令并打开", exact: true }).click();
  await expect(page.getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
}

test("个人设备默认记住30天，刷新与新标签直接恢复，主动锁定撤销所有页面", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRemembered(page);
  const cipher = await page.evaluate(key => localStorage.getItem(key), KEY);
  const details = await trustDetails(page);
  expect(details!.extractable).toBe(false);
  expect(details!.algorithm).toBe("AES-GCM");
  expect(details!.expiresAt - details!.createdAt).toBe(30 * 86400_000);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(PASSWORD);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(await trustDetails(page)).toEqual(details);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
  const other = await context.newPage();
  await other.goto("./");
  await expect(other.getByRole("navigation", { name: "主导航" })).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "锁定我的空间", exact: true }).click();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  await expect(other.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  await expect.poll(() => trustDetails(page)).toBeNull();
  await Promise.all([page.reload(), other.reload()]);
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  await expect(other.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
  await other.close();
});

test("过期和后台页面恢复重新检查设备许可，保留密文并要求口令", async ({ page }) => {
  await openRemembered(page);
  const cipher = await page.evaluate(key => localStorage.getItem(key), KEY);
  await page.evaluate(async database => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(database, 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("trust", "readwrite"); const store = tx.objectStore("trust"); const request = store.get("device");
      request.onsuccess = () => { const record = request.result; record.device.expiresAt = Date.now() - 1; record.device.createdAt = record.device.expiresAt - 30 * 86400_000; store.put(record, "device"); }; tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    }); db.close();
  }, DEVICE_DB);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
  await page.reload();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
});

test("设备记忆存储失败仍可使用本次口令解锁，刷新需要重新验证", async ({ page }) => {
  await page.addInitScript(database => {
    const native = indexedDB.open.bind(indexedDB);
    indexedDB.open = function(name: string, version?: number) {
      if (name === database) throw new DOMException("blocked", "SecurityError");
      return version === undefined ? native(name) : native(name, version);
    };
  }, DEVICE_DB);
  await openRemembered(page);
  await expect(page.locator(".workspace-trust-notice")).toContainText("下次打开仍需口令");
  const cipher = await page.evaluate(key => localStorage.getItem(key), KEY);
  await page.reload();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
});

test("已解锁页面恢复焦点不会重建工作台或丢失正在编辑的草稿", async ({ page }) => {
  await openRemembered(page);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "思考", exact: true }).click();
  await page.getByRole("button", { name: "新建思考", exact: true }).click();
  await page.getByLabel("思考标题", { exact: true }).fill("合成测试的未保存草稿");
  await page.getByRole("textbox", { name: "我的想法", exact: true }).fill("切换到别的窗口后回来，这段话仍应保留。");
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByLabel("思考标题", { exact: true })).toHaveValue("合成测试的未保存草稿");
  await expect(page.getByRole("textbox", { name: "我的想法", exact: true })).toHaveValue("切换到别的窗口后回来，这段话仍应保留。");
});

test("撤销记录写入失败仍以持久标记阻止刷新自动解锁", async ({ page }) => {
  await openRemembered(page);
  const cipher = await page.evaluate(key => localStorage.getItem(key), KEY);
  await page.evaluate(database => {
    const native = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase["transaction"]>) {
      const tx = native.apply(this, args);
      if (this.name === database && args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    };
  }, DEVICE_DB);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "锁定我的空间", exact: true }).click();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-gate-error")).toContainText("未能确认设备记忆已取消");
  await page.reload();
  await expect(page.getByRole("heading", { name: "解锁有序", exact: true })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(cipher);
});
