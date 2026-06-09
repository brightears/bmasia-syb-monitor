import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { relativeTime } from "@/lib/utils";
import AddAccountButton from "./AddAccountButton";
import DeleteAccountButton from "./DeleteAccountButton";

export default async function Dashboard() {
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");

  const accounts = await prisma.account.findMany({
    orderBy: [{ monitored: "desc" }, { businessName: "asc" }],
    include: {
      _count: {
        select: {
          zones: { where: { monitored: true } },
          alerts: { where: { resolvedAt: null } },
        },
      },
    },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--fg-dim)]">
            {accounts.length} account{accounts.length === 1 ? "" : "s"} tracked.
            Click an account to set baselines + apply prevention.
          </p>
        </div>
        <AddAccountButton />
      </div>

      {accounts.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--border)] p-12 text-center">
          <p className="text-[var(--fg-dim)]">No accounts onboarded yet.</p>
          <p className="mt-2 text-sm text-[var(--fg-dim)]">
            Click <span className="text-[var(--fg)]">Add account</span> above to pick one from SYB.
          </p>
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--fg-dim)]">
              <th className="border-b border-[var(--border)] py-2 pr-4">Account</th>
              <th className="border-b border-[var(--border)] py-2 pr-4">Monitored</th>
              <th className="border-b border-[var(--border)] py-2 pr-4">Prevention</th>
              <th className="border-b border-[var(--border)] py-2 pr-4">Auto-revert</th>
              <th className="border-b border-[var(--border)] py-2 pr-4">Zones</th>
              <th className="border-b border-[var(--border)] py-2 pr-4">Open alerts</th>
              <th className="border-b border-[var(--border)] py-2 pr-4">Last poll</th>
              <th className="border-b border-[var(--border)] py-2"></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} className="hover:bg-[var(--bg-elev)]">
                <td className="py-2 pr-4">
                  <Link href={`/accounts/${a.id}`} className="no-underline text-[var(--fg)] hover:underline">
                    {a.businessName}
                  </Link>
                </td>
                <td className="py-2 pr-4">
                  {a.monitored ? <span className="text-[var(--ok)]">on</span> : <span className="text-[var(--fg-dim)]">off</span>}
                </td>
                <td className="py-2 pr-4">
                  {a.preventionApplied ? <span className="text-[var(--ok)]">applied</span> : <span className="text-[var(--fg-dim)]">—</span>}
                </td>
                <td className="py-2 pr-4">
                  {a.autoRevertEnabled ? <span className="text-[var(--ok)]">on</span> : <span className="text-[var(--fg-dim)]">off</span>}
                </td>
                <td className="py-2 pr-4">{a._count.zones}</td>
                <td className="py-2 pr-4">
                  {a._count.alerts > 0 ? (
                    <Link href={`/alerts?account=${a.id}`} className="no-underline text-[var(--warn)] hover:underline">
                      {a._count.alerts}
                    </Link>
                  ) : (
                    <span className="text-[var(--fg-dim)]">0</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-[var(--fg-dim)]">{relativeTime(a.lastPolledAt)}</td>
                <td className="py-2 text-right">
                  <DeleteAccountButton accountId={a.id} businessName={a.businessName} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
