import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { StoreConflict } from "./store";

export class HttpError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function checkMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const url = new URL(request.url);
  // Next may normalize request.url to localhost. Host is the destination the
  // browser actually reached; browsers cannot override their Host header.
  const host = request.headers.get("host") || url.host;
  const expectedOrigin = `${url.protocol}//${host}`;
  try {
    if (new URL(origin).origin === new URL(expectedOrigin).origin) return;
  } catch { /* Reject malformed origins without reflecting them. */ }
  throw new HttpError("请从应用页面提交。", 403);
}

export async function readJson(request: Request, maxBytes = 500_000): Promise<unknown> {
  checkMutation(request);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError("请提交 JSON 格式的内容。", 415);
  const length = Number(request.headers.get("content-length"));
  if (length > maxBytes) throw new HttpError("内容太大，请分批导入。", 413);
  if (!request.body) throw new HttpError("提交内容为空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError("内容太大，请分批导入。", 413);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError("JSON 内容不完整，请检查后重试。"); }
}

export function apiError(error: unknown) {
  if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof StoreConflict) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error instanceof ZodError) return NextResponse.json({ error: `内容格式有误：${error.issues.map(issue => `${issue.path.join(".") || "内容"} ${issue.message}`).slice(0, 3).join("；")}` }, { status: 400 });
  // Never include submitted content, database paths or stack traces in the response.
  console.error("Life workbench request failed:", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "保存服务暂时不可用，请保留整理结果后重试。" }, { status: 500 });
}
