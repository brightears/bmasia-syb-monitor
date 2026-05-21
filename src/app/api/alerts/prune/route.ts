/**
 * Bulk-prune Alert rows older than a cutoff. Agent / admin tool.
 *
 *   curl -X POST -H "Authorization: Bearer $AGENT_API_TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d '{"beforeIso":"2026-05-21T01:50:00Z"}' \
 *     $APP/api/alerts/prune
 *
 * Optional filter: `action` (e.g. "ACCOUNT_SETTING_CHANGED") narrows the delete
 * to a single action type.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionOrToken, UnauthorizedError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  beforeIso: z.string().datetime(),
  action: z.string().optional(),
  onlyUnresolved: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
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
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid payload", detail: (e as Error).message },
      { status: 400 }
    );
  }

  const where: {
    timestamp: { lt: Date };
    action?: string;
    resolvedAt?: null;
  } = { timestamp: { lt: new Date(body.beforeIso) } };
  if (body.action) where.action = body.action;
  if (body.onlyUnresolved) where.resolvedAt = null;

  const before = await prisma.alert.count({ where });
  const deleted = await prisma.alert.deleteMany({ where });

  return NextResponse.json({
    matched: before,
    deleted: deleted.count,
    filter: body,
  });
}
