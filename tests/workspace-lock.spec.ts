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
