import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let work;
try {
  work = await mkdtemp(path.join(root, ".weread-sync-build-"));
  await mkdir(path.join(work, "scripts"));
  await mkdir(path.join(work, "lib"));
  // Explicit sources only: no environment files, application state or database.
  const files = [
    "scripts/weread-sync-job.ts", "lib/types.ts", "lib/dates.ts", "lib/reading.ts",
    "lib/reading-envelope.ts", "lib/reading-sync-status.ts", "lib/weread.ts", "lib/weread-sync.ts",
  ];
  for (const filename of files) {
    const source = await readFile(path.join(root, filename), "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    await writeFile(path.join(work, filename.replace(/\.ts$/, ".js")), compiled.outputText);
  }
  await writeFile(path.join(work, "package.json"), '{"type":"commonjs"}\n');
  await symlink(path.join(root, "node_modules"), path.join(work, "node_modules"), "dir");
  const job = createRequire(import.meta.url)(path.join(work, "scripts/weread-sync-job.js"));
  if (!await job.runWeReadSyncCli(process.env)) process.exitCode = 1;
} catch {
  console.error("WeRead synchronization could not start. Deployment is stopped to preserve existing reading history. No credential or reading content is logged.");
  process.exitCode = 1;
} finally {
  if (work) await rm(work, { recursive: true, force: true });
}
