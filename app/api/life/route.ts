import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { apiError, readJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return NextResponse.json(getStore().getLife(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    return NextResponse.json(getStore().saveLife(await readJson(request, 5_000_000)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    // The request includes both the original module snapshot and its replacement.
    return NextResponse.json(getStore().patchLife(await readJson(request, 10_000_000)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
