import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { taskPatchSchema } from "@/lib/validation";
import { apiError, checkMutation, HttpError, readJson } from "@/lib/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const patch = taskPatchSchema.parse(await readJson(request));
    const task = getStore().update(id, patch);
    if (!task) throw new HttpError("这条待办不存在，可能已经删除。", 404);
    return NextResponse.json(task);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    checkMutation(request);
    const { id } = await context.params;
    if (!getStore().remove(id)) throw new HttpError("这条待办不存在，可能已经删除。", 404);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
