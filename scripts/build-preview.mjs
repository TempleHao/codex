import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.env.LIFE_BASE_PATH ?? "/codex";
const basePath = requested === "/" ? "" : requested.replace(/\/$/, "");
if (basePath && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(basePath)) {
  throw new Error("LIFE_BASE_PATH must be empty or a safe absolute website path, such as /codex.");
}
const work = await mkdtemp(path.join(root, ".preview-build-"));
try {
  await mkdir(path.join(work, "app"));
  await mkdir(path.join(work, "lib"));
  // Copy an explicit source list: no API routes, personal database or .env files.
  for (const name of ["page.tsx", "layout.tsx", "globals.css", "icon.svg"]) {
    await cp(path.join(root, "app", name), path.join(work, "app", name));
  }
  for (const name of ["types.ts", "dates.ts", "validation.ts", "import.ts", "client.ts", "backup.ts", "life.ts", "reading.ts", "weread.ts", "weread-sync.ts", "reading-envelope.ts", "reading-sync-status.ts", "media.ts", "trakt.ts"]) {
    await cp(path.join(root, "lib", name), path.join(work, "lib", name));
  }
  await cp(path.join(root, "components"), path.join(work, "components"), { recursive: true });
  await cp(path.join(root, "public"), path.join(work, "public"), { recursive: true });
  for (const name of ["package.json", "tsconfig.json"]) await cp(path.join(root, name), path.join(work, name));
  await symlink(path.join(root, "node_modules"), path.join(work, "node_modules"), "dir");
  const config = { output: "export", basePath, trailingSlash: true, images: { unoptimized: true }, poweredByHeader: false, turbopack: { root } };
  await writeFile(path.join(work, "next.config.mjs"), `export default ${JSON.stringify(config, null, 2)};\n`);
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", work], {
    cwd: work,
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_PREVIEW_MODE: "true", NEXT_PUBLIC_BASE_PATH: basePath },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Static preview build failed (exit ${result.status}).`);
  const output = path.join(root, "preview-out");
  await rm(output, { recursive: true, force: true });
  await cp(path.join(work, "out"), output, { recursive: true });
  await writeFile(path.join(output, ".nojekyll"), "");
  await writeFile(path.join(output, "preview-config.json"), JSON.stringify({ basePath }));
  const html = await readFile(path.join(output, "index.html"), "utf8");
  if (!html.includes("有序")) throw new Error("Static export is missing the application homepage.");
  console.log(`GitHub Pages 静态版已生成到 preview-out/，网站路径 ${basePath || "/"}。`);
} finally {
  await rm(work, { recursive: true, force: true });
}
