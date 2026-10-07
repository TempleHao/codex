import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../preview-out");
const { basePath } = JSON.parse(await readFile(path.join(output, "preview-config.json"), "utf8"));
const port = Number(process.env.LIFE_PREVIEW_PORT || 3200);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

createServer(async (request, response) => {
  try {
    if (!["GET", "HEAD"].includes(request.method || "GET")) { response.writeHead(405); response.end(); return; }
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    if (basePath && pathname === "/") { response.writeHead(302, { Location: `${basePath}/` }); response.end(); return; }
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) { response.writeHead(404); response.end(); return; }
    const relative = pathname.slice(basePath.length) || "/";
    let filename = path.resolve(output, `.${relative}`);
    if (filename !== output && !filename.startsWith(`${output}${path.sep}`)) { response.writeHead(404); response.end(); return; }
    const info = await stat(filename);
    if (info.isDirectory()) filename = path.join(filename, "index.html");
    const content = await readFile(filename);
    response.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch { response.writeHead(404); response.end(); }
}).listen(port, "127.0.0.1", () => console.log(`静态版内部验证服务已启动（端口 ${port}）。`));
