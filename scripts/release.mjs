import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export function readRelease(root = process.cwd()) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const version = pkg.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("版本号必须为 x.y.z。");
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("package.json 与锁文件的版本号不一致。");
  }
  const sections = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/^## /m).slice(1);
  const matches = sections.filter(section => section.startsWith(`[${version}] - `));
  if (matches.length !== 1) throw new Error(`CHANGELOG.md 必须恰有一节 [${version}] 更新记录。`);
  const [heading, ...body] = matches[0].split("\n");
  const date = heading.match(/^\[\d+\.\d+\.\d+\] - (\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!date || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("更新记录必须包含有效的 YYYY-MM-DD 发布日期。");
  }
  const notes = body.join("\n").trim();
  if (!/^- \S/m.test(notes)) throw new Error("更新记录必须包含具体变更条目。");
  return { version, tag: `v${version}`, notes };
}

function ghApi(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (/HTTP 404/.test(result.stderr)) return null;
    throw new Error(`GitHub 查询失败：${endpoint}；请检查连接与仓库权限。`);
  }
  return JSON.parse(result.stdout);
}

export function verifyReleaseTag(repo, commit, tag, api = ghApi) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("发布需要 owner/repo 和完整的 40 位提交编号。");
  }
  const ref = api(`repos/${repo}/git/ref/tags/${tag}`);
  if (!ref) return;
  let object = ref.object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth++) {
    object = api(`repos/${repo}/git/tags/${object.sha}`)?.object;
  }
  if (object?.type !== "commit" || object.sha !== commit) {
    throw new Error(`${tag} 已属于另一个提交。请提升版本号并补充更新记录，不要移动已发布标签。`);
  }
}

function publishRelease(repo, commit, release) {
  verifyReleaseTag(repo, commit, release.tag);
  const existing = ghApi(`repos/${repo}/releases/tags/${release.tag}`);
  if (existing) {
    if (existing.draft) throw new Error(`${release.tag} 已有草稿，请先处理该草稿。`);
    console.log(`${release.tag} 已发布，保留原版本。`);
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), "life-release-"));
  try {
    const notesFile = join(temporary, "notes.md");
    writeFileSync(notesFile, release.notes);
    const result = spawnSync("gh", ["release", "create", release.tag, "--repo", repo,
      "--target", commit, "--title", `有序 · 人生工作台 ${release.tag}`, "--notes-file", notesFile], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("GitHub Release 创建失败；可在修复权限后重新运行工作流。");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const value = flag => args[args.indexOf(flag) + 1];
    const release = readRelease();
    const repo = args.includes("--repo") ? value("--repo") : process.env.GITHUB_REPOSITORY;
    const commit = args.includes("--commit") ? value("--commit") : process.env.GITHUB_SHA;
    if (args.includes("--publish")) publishRelease(repo, commit, release);
    else if (args.includes("--verify-tag")) verifyReleaseTag(repo, commit, release.tag);
    console.log(`${release.tag}：版本号、锁文件和更新记录一致。`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
