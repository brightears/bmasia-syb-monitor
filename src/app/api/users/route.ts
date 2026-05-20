/**
 * Admin-only user management.
 *
 *   POST /api/users → create a user (role-gated: only admin sessions, or bearer-token agent calls)
 *   GET  /api/users → list users
 *
 * Until a self-serve invite flow exists, this is how new operators get accounts.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  hashPassword,
  isEmailAllowed,
  requireSessionOrToken,
  UnauthorizedError,
} from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional(),
  role: z.enum(["operator", "admin"]).default("operator"),
});

export async function POST(req: NextRequest) {
  let actor: { kind: string; email: string; role: string };
  try {
    actor = await requireSessionOrToken(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  if (actor.kind === "session" && actor.role !== "admin") {
    return NextResponse.json(
      { error: "Admin role required" },
      { status: 403 }
    );
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const email = body.email.toLowerCase();
  if (!isEmailAllowed(email)) {
    return NextResponse.json(
      { error: `${email} is not in ALLOWED_EMAILS — add it to the env var first.` },
      { status: 400 }
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "User already exists", id: existing.id },
      { status: 409 }
    );
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(body.password),
      name: body.name ?? null,
      role: body.role,
    },
  });

  return NextResponse.json({
    id: user.id,
    email: user.email,
    role: user.role,
    createdBy: actor.email,
  });
}

export async function GET(req: NextRequest) {
  let actor: { kind: string; email: string; role: string };
  try {
    actor = await requireSessionOrToken(req);
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
  if (actor.kind === "session" && actor.role !== "admin") {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, createdAt: true },
    orderBy: { id: "asc" },
  });
  return NextResponse.json({ users });
}
