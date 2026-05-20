import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, UnauthorizedError } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAccountWithZones } from "@/lib/syb-queries";
import { syncZoneInventory } from "@/lib/baseline";

const schema = z.object({
  accountId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    await requireSession();
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

  const remote = await getAccountWithZones(body.accountId);
  if (!remote) {
    return NextResponse.json(
      { error: "SYB returned no account for that ID" },
      { status: 404 }
    );
  }

  await prisma.account.upsert({
    where: { id: remote.id },
    create: {
      id: remote.id,
      businessName: remote.businessName,
    },
    update: {
      businessName: remote.businessName,
    },
  });

  await syncZoneInventory(remote.id);

  return NextResponse.json({ id: remote.id, businessName: remote.businessName });
}
