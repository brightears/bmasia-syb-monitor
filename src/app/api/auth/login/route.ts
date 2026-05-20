import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, isEmailAllowed, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const email = body.email.toLowerCase();

  if (!isEmailAllowed(email)) {
    return NextResponse.json(
      { error: "Email not allowed. Ask Norbert to add you to ALLOWED_EMAILS." },
      { status: 403 }
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const session = await getSession();
  session.userId = user.id;
  session.email = user.email;
  session.role = user.role;
  session.isLoggedIn = true;
  await session.save();

  return NextResponse.json({ ok: true });
}
