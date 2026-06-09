import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { relativeTime } from "@/lib/utils";
import AccountControls from "./AccountControls";

export default async function AccountPage(props: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");

  const { id } = await props.params;
  const account = await prisma.account.findUnique({
    where: { id },
    include: {
      zones: { orderBy: { name: "asc" } },
      _count: { select: { alerts: { where: { resolvedAt: null } } } },
    },
  });
  if (!account) notFound();

  return (
    <div>
      <div className="mb-2 text-sm text-[var(--fg-dim)]">
        <Link href="/dashboard" className="no-underline">← Dashboard</Link>
      </div>
      <h1 className="mb-6 text-2xl font-semibold">{account.businessName}</h1>

      <AccountControls
        accountId={account.id}
        businessName={account.businessName}
        monitored={account.monitored}
        autoRevertEnabled={account.autoRevertEnabled}
        preventionApplied={account.preventionApplied}
        zones={account.zones.map((z) => ({
          id: z.id,
          name: z.name,
          monitored: z.monitored,
          approvedPlayFromId: z.approvedPlayFromId,
          approvedPlayFromName: z.approvedPlayFromName,
          lastSeenPlayFromId: z.lastSeenPlayFromId,
          lastSeenPlayFromName: z.lastSeenPlayFromName,
          baselineCapturedAt: z.baselineCapturedAt?.toISOString() ?? null,
          driftDetectedAt: z.driftDetectedAt?.toISOString() ?? null,
          staffControlLocked: z.staffControlLocked,
        }))}
      />

      <div className="mt-8 grid grid-cols-3 gap-6 text-sm">
        <div>
          <div className="text-[var(--fg-dim)]">Open alerts</div>
          <div className="text-lg">{account._count.alerts}</div>
        </div>
        <div>
          <div className="text-[var(--fg-dim)]">Last polled</div>
          <div className="text-lg">{relativeTime(account.lastPolledAt)}</div>
        </div>
        <div>
          <div className="text-[var(--fg-dim)]">Onboarded</div>
          <div className="text-lg">{relativeTime(account.onboardedAt)}</div>
        </div>
      </div>
    </div>
  );
}
