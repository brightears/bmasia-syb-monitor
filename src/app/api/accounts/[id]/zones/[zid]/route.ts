import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { captureBaseline } from "@/lib/baseline";

const schema = z.object({
  monitored: z.boolean().optional(),
  captureBaseline: z.boolean().optional(),
  overrideBaseline: z
    .object({
      playFromId: z.string(),
      playFromName: z.string().optional(),
      playFromType: z.string().optional(),
    })
    .optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; zid: string }> }
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

  const { id, zid } = await ctx.params;
  const zone = await prisma.zone.findUnique({ where: { id: zid } });
  if (!zone || zone.accountId !== id) {
    return NextResponse.json({ error: "Zone not found" }, { status: 404 });
  }

  if (typeof body.monitored === "boolean") {
    await prisma.zone.update({
      where: { id: zid },
      data: { monitored: body.monitored },
    });
  }

  if (body.captureBaseline) {
    try {
      await captureBaseline(zid, {
        overridePlayFromId: body.overrideBaseline?.playFromId,
        overridePlayFromName: body.overrideBaseline?.playFromName,
        overridePlayFromType: body.overrideBaseline?.playFromType,
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  const fresh = await prisma.zone.findUniqueOrThrow({ where: { id: zid } });
  return NextResponse.json(fresh);
}
