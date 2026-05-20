import { NextRequest, NextResponse } from "next/server";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { applyPrevention } from "@/lib/prevention";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  let actor: { kind: string; email: string };
  try {
    actor = await requireSessionOrToken(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const { id } = await ctx.params;
  try {
    const result = await applyPrevention(id, { appliedBy: actor.email });
    if (result.errors.length > 0) {
      return NextResponse.json(
        {
          error: `Partial failure — ${result.errors.length} of the SYB mutations failed. First: ${result.errors[0].scope} — ${result.errors[0].message}`,
          partial: result,
        },
        { status: 502 }
      );
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
