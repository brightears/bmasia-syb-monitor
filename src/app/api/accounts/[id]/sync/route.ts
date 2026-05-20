import { NextRequest, NextResponse } from "next/server";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { syncZoneInventory } from "@/lib/baseline";
import { pollOneAccount } from "@/lib/poll-core";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    await requireSessionOrToken(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const { id } = await ctx.params;
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const inventory = await syncZoneInventory(id);
    let poll = null;
    if (account.monitored) {
      poll = await pollOneAccount(id);
    }
    return NextResponse.json({ inventory, poll });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
