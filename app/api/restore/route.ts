import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { backupSchema } from "@/lib/backup";
import { apiError, readJson } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const backup = backupSchema.parse(await readJson(request, 5_000_000));
    return NextResponse.json(getStore().restore(backup));
  } catch (error) { return apiError(error); }
}
