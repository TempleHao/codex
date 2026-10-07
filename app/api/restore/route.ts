import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { backupSchema, MAX_BACKUP_BYTES } from "@/lib/backup";
import { apiError, readJson } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const backup = backupSchema.parse(await readJson(request, MAX_BACKUP_BYTES));
    const store = getStore();
    return NextResponse.json(store.restore(backup), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
