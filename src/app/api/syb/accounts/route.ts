import { NextRequest, NextResponse } from "next/server";
import { requireSession, UnauthorizedError } from "@/lib/auth";
import { listAccounts } from "@/lib/syb-queries";

export async function GET(_req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
