import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  monitored: z.boolean().optional(),
  autoRevertEnabled: z.boolean().optional(),
  chatSpaceId: z.string().nullable().optional(),
  telegramChatId: z.string().nullable().optional(),
});

export async function PATCH(
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

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { id } = await ctx.params;

  if (body.autoRevertEnabled === true) {
    const hasBaseline = await prisma.zone.findFirst({
      where: { accountId: id, monitored: true, approvedPlayFromId: { not: null } },
    });
    if (!hasBaseline) {
      return NextResponse.json(
        { error: "Cannot enable auto-revert: capture at least one zone baseline first." },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.account.update({
    where: { id },
    data: body,
  });

  return NextResponse.json({
    id: updated.id,
    monitored: updated.monitored,
    autoRevertEnabled: updated.autoRevertEnabled,
  });
}

export async function GET(
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
  const account = await prisma.account.findUnique({
    where: { id },
    include: { zones: true },
  });
  if (!account) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(account);
}
