import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  resolution: z.enum(["acknowledged", "ignored", "manual-reverted"]),
  note: z.string().optional(),
});

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

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { id } = await ctx.params;
  const alert = await prisma.alert.findUnique({ where: { id } });
  if (!alert) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (alert.resolvedAt) {
    return NextResponse.json(
      { error: "Alert already resolved" },
      { status: 409 }
    );
  }

  const updated = await prisma.alert.update({
    where: { id },
    data: {
      resolution: body.resolution,
      resolutionNote: body.note ?? null,
      resolvedAt: new Date(),
      resolvedBy: actor.email,
    },
  });

  return NextResponse.json(updated);
}
