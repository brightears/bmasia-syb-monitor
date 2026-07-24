import { NextRequest, NextResponse } from "next/server";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revertToBaseline } from "@/lib/baseline";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; zid: string }> }
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

  const { id, zid } = await ctx.params;
  const zone = await prisma.zone.findUnique({ where: { id: zid } });
  if (!zone || zone.accountId !== id) {
    return NextResponse.json({ error: "Zone not found" }, { status: 404 });
  }

  if (!zone.approvedPlayFromId) {
    return NextResponse.json(
      { error: "No approved baseline captured for this zone." },
      { status: 400 }
    );
  }

  try {
    const result = await revertToBaseline(zid);

    // Only resolve alerts if the zone actually switched back. If it didn't take
    // (e.g. the source was rejected), say so instead of falsely marking it fixed.
    if (!result.reverted) {
      return NextResponse.json(
        {
          reverted: false,
          error:
            `Revert didn't take — the zone is still on ` +
            `"${result.observedPlayFromName ?? "another source"}" instead of ` +
            `"${result.playFromName ?? "the baseline"}". If this is a SONOS zone, ` +
            `confirm it accepted the change in SYB.`,
        },
        { status: 422 }
      );
    }

    // Mark all open PLAY_FROM_CHANGED alerts on this zone as resolved
    await prisma.alert.updateMany({
      where: { zoneId: zid, action: "PLAY_FROM_CHANGED", resolvedAt: null },
      data: {
        resolution: "manual-reverted",
        resolvedAt: new Date(),
        resolvedBy: actor.email,
      },
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
