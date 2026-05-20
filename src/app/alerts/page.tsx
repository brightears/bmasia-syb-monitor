import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/utils";
import AlertRowActions from "./AlertRowActions";

function fmtJsonLike(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.id === "string") return o.id;
    return JSON.stringify(v).slice(0, 100);
  }
  return String(v);
}

function severityBadge(sev: string): { bg: string; fg: string } {
  if (sev === "critical") return { bg: "var(--crit)", fg: "white" };
  if (sev === "warn") return { bg: "var(--warn)", fg: "black" };
  return { bg: "var(--border)", fg: "var(--fg-dim)" };
}

export default async function AlertsPage(props: {
  searchParams: Promise<{ account?: string; status?: string }>;
}) {
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");

  const { account: accountFilter, status } = await props.searchParams;

  const showResolved = status === "all";
  const alerts = await prisma.alert.findMany({
    where: {
      ...(accountFilter ? { accountId: accountFilter } : {}),
      ...(showResolved ? {} : { resolvedAt: null }),
    },
    orderBy: { timestamp: "desc" },
    take: 200,
    include: {
      account: { select: { businessName: true } },
      zone: { select: { name: true, approvedPlayFromName: true } },
    },
  });

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Alerts</h1>
          <p className="mt-1 text-sm text-[var(--fg-dim)]">
            {showResolved ? "All alerts" : "Open alerts only"}
            {accountFilter ? ` · account=${accountFilter}` : ""}
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link
            href={`/alerts${accountFilter ? `?account=${accountFilter}` : ""}`}
            className={`no-underline ${!showResolved ? "text-[var(--fg)]" : "text-[var(--fg-dim)]"}`}
          >
            Open
          </Link>
          <Link
            href={`/alerts?status=all${accountFilter ? `&account=${accountFilter}` : ""}`}
            className={`no-underline ${showResolved ? "text-[var(--fg)]" : "text-[var(--fg-dim)]"}`}
          >
            All
          </Link>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--border)] p-12 text-center text-[var(--fg-dim)]">
          No alerts.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {alerts.map((a) => {
            const sev = severityBadge(a.severity);
            return (
              <li key={a.id} className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span
                        className="rounded px-1.5 py-0.5 text-xs font-medium"
                        style={{ background: sev.bg, color: sev.fg }}
                      >
                        {a.severity}
                      </span>
                      <span className="font-medium">{a.action}</span>
                      <Link
                        href={`/accounts/${a.accountId}`}
                        className="text-[var(--fg-dim)] no-underline hover:underline"
                      >
                        {a.account.businessName}
                      </Link>
                      {a.zone && (
                        <span className="text-[var(--fg-dim)]">
                          → zone <span className="text-[var(--fg)]">{a.zone.name}</span>
                        </span>
                      )}
                      <span className="text-xs text-[var(--fg-dim)]">{formatDateTime(a.timestamp)}</span>
                    </div>
                    <div className="mt-1 text-sm text-[var(--fg-dim)]">
                      by <span className="text-[var(--fg)]">{a.actorEmail ?? a.actorName ?? a.actorType}</span>
                      {" · "}
                      <span>
                        {fmtJsonLike(a.diffOld)} → {fmtJsonLike(a.diffNew)}
                      </span>
                      {a.zone?.approvedPlayFromName && (
                        <span className="ml-2 text-xs">
                          (approved baseline: {a.zone.approvedPlayFromName})
                        </span>
                      )}
                    </div>
                    {a.description && (
                      <div className="mt-1 text-xs text-[var(--fg-dim)]">{a.description}</div>
                    )}
                    {a.resolution && (
                      <div className="mt-1 text-xs text-[var(--ok)]">
                        ✓ {a.resolution}
                        {a.resolvedBy ? ` by ${a.resolvedBy}` : ""}
                        {a.resolvedAt ? ` · ${formatDateTime(a.resolvedAt)}` : ""}
                      </div>
                    )}
                  </div>
                  {a.resolvedAt === null && (
                    <AlertRowActions
                      alertId={a.id}
                      canRevert={a.action === "PLAY_FROM_CHANGED" && a.zoneId !== null}
                      accountId={a.accountId}
                      zoneId={a.zoneId}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
