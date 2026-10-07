import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { importBatchSchema } from "@/lib/validation";
import { apiError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return NextResponse.json(getStore().snapshot(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const batch = importBatchSchema.parse(await readJson(request));
    return NextResponse.json(getStore().addBatch(batch), { status: 201 });
  } catch (error) { return apiError(error); }
}
