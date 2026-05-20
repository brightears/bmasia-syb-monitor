/**
 * One-time admin bootstrap.
 *
 *   curl -X POST $APP/api/auth/bootstrap \
 *     -H "X-Bootstrap-Token: $ADMIN_PASSWORD" \
 *     -H "Content-Type: application/json" \
 *     -d '{"email":"norbert@bmasiamusic.com","password":"<strong-pw>"}'
 *
 * Refuses if any User row already exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, isEmailAllowed } from "@/lib/auth";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const headerToken = req.headers.get("x-bootstrap-token");
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !headerToken || headerToken !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.user.count();
  if (existing > 0) {
    return NextResponse.json(
      { error: "Bootstrap already complete — at least one user exists." },
      { status: 409 }
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
      { error: `${email} is not in ALLOWED_EMAILS.` },
      { status: 400 }
    );
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(body.password),
      name: body.name ?? null,
      role: "admin",
    },
  });

  return NextResponse.json({ ok: true, id: user.id, email: user.email });
}
