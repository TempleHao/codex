import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRelease, verifyReleaseTag } from "./release.mjs";

const directories: string[] = [];
function fixture(lockVersion = "0.2.0", changelog = "## [0.2.0] - 2026-10-09\n\n- 完整项目介绍。\n\n## [0.1.0] - 2026-10-07\n\n- 旧版本。") {
  const root = mkdtempSync(join(tmpdir(), "life-release-test-"));
  directories.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: lockVersion, packages: { "": { version: lockVersion } } }));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return root;
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("发布前校验", () => {
  it("只提取当前版本的说明，排除其他版本", () => {
    expect(readRelease(fixture())).toEqual({ version: "0.2.0", tag: "v0.2.0", notes: "- 完整项目介绍。" });
  });
  it("锁文件版本漂移会阻止发布", () => {
    expect(() => readRelease(fixture("0.1.0"))).toThrow("版本号不一致");
  });
  it.each([
    ["缺少当前版本", "## [0.1.0] - 2026-10-07\n\n- 旧版本。"],
    ["重复当前版本", "## [0.2.0] - 2026-10-09\n- 内容。\n## [0.2.0] - 2026-10-09\n- 内容。"],
    ["没有具体变更", "## [0.2.0] - 2026-10-09\n\n待补充"],
    ["不存在的日期", "## [0.2.0] - 2026-02-30\n\n- 内容。"],
  ])("%s 会阻止发布", (_name, changelog) => {
    expect(() => readRelease(fixture("0.2.0", changelog))).toThrow();
  });
  it("没有标签时可以发布，同提交重复运行安全通过", () => {
    const sha = "a".repeat(40);
    expect(() => verifyReleaseTag("example/repo", sha, "v0.2.0", () => null)).not.toThrow();
    expect(() => verifyReleaseTag("example/repo", sha, "v0.2.0", () => ({ object: { type: "commit", sha } }))).not.toThrow();
  });
  it("轻量和附注标签都不能挪到其他提交", () => {
    const api = vi.fn().mockReturnValueOnce({ object: { type: "tag", sha: "b".repeat(40) } })
      .mockReturnValueOnce({ object: { type: "commit", sha: "c".repeat(40) } });
    expect(() => verifyReleaseTag("example/repo", "a".repeat(40), "v0.2.0", api)).toThrow("提升版本号");
    expect(() => verifyReleaseTag("example/repo", "a".repeat(40), "v0.2.0", () => ({ object: { type: "commit", sha: "c".repeat(40) } }))).toThrow("提升版本号");
  });
});
