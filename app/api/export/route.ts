import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { chinaToday } from "@/lib/dates";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ format: "life-workbench-backup", version: 1, exportedAt: new Date().toISOString(), ...getStore().snapshot() }, {
      headers: { "Content-Disposition": `attachment; filename="life-backup-${chinaToday()}.json"`, "Cache-Control": "no-store" },
    });
  } catch (error) { return apiError(error); }
}
