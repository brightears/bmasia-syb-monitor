import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/utils";
import AlertRowActions from "../AlertRowActions";

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.id === "string") return o.id;
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

function severityBadge(sev: string): { bg: string; fg: string } {
  if (sev === "critical") return { bg: "var(--crit)", fg: "white" };
  if (sev === "warn") return { bg: "var(--warn)", fg: "black" };
  return { bg: "var(--border)", fg: "var(--fg-dim)" };
}

export default async function AlertDetail(props: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");

  const { id } = await props.params;
  const alert = await prisma.alert.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, businessName: true } },
      zone: { select: { id: true, name: true, approvedPlayFromName: true, approvedPlayFromId: true } },
    },
  });
  if (!alert) notFound();

  const sev = severityBadge(alert.severity);

  return (
    <div>
      <div className="mb-2 text-sm text-[var(--fg-dim)]">
        <Link href="/alerts" className="no-underline">← Alerts</Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-xs font-medium"
              style={{ background: sev.bg, color: sev.fg }}
            >
              {alert.severity}
            </span>
            <h1 className="text-2xl font-semibold">{alert.action}</h1>
          </div>
          <p className="text-sm text-[var(--fg-dim)]">
            on{" "}
            <Link href={`/accounts/${alert.account.id}`} className="no-underline">
              {alert.account.businessName}
            </Link>
            {alert.zone && (
              <>
                {" "}— zone <span className="text-[var(--fg)]">{alert.zone.name}</span>
              </>
            )}
            {" · "}
            {formatDateTime(alert.timestamp)}
          </p>
        </div>
        {alert.resolvedAt === null && (
          <AlertRowActions
            alertId={alert.id}
            canRevert={alert.action === "PLAY_FROM_CHANGED" && alert.zoneId !== null}
            accountId={alert.accountId}
            zoneId={alert.zoneId}
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <h2 className="mb-3 text-sm font-medium">Actor</h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-[var(--fg-dim)]">Type</dt>
              <dd>{alert.actorType}</dd>
            </div>
            {alert.actorName && (
              <div>
                <dt className="text-[var(--fg-dim)]">Name</dt>
                <dd>{alert.actorName}</dd>
              </div>
            )}
            {alert.actorEmail && (
              <div>
                <dt className="text-[var(--fg-dim)]">Email</dt>
                <dd>{alert.actorEmail}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="rounded border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <h2 className="mb-3 text-sm font-medium">Change</h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-[var(--fg-dim)]">From</dt>
              <dd>
                <pre className="overflow-auto rounded bg-[var(--bg)] p-2 text-xs">{fmt(alert.diffOld)}</pre>
              </dd>
            </div>
            <div>
              <dt className="text-[var(--fg-dim)]">To</dt>
              <dd>
                <pre className="overflow-auto rounded bg-[var(--bg)] p-2 text-xs">{fmt(alert.diffNew)}</pre>
              </dd>
            </div>
            {alert.zone?.approvedPlayFromName && (
              <div>
                <dt className="text-[var(--fg-dim)]">Approved baseline</dt>
                <dd>{alert.zone.approvedPlayFromName}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {alert.description && (
        <section className="mt-6 rounded border border-[var(--border)] bg-[var(--bg-elev)] p-4">
          <h2 className="mb-2 text-sm font-medium">Description</h2>
          <p className="text-sm">{alert.description}</p>
        </section>
      )}

      <section className="mt-6 rounded border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <h2 className="mb-2 text-sm font-medium">Resolution</h2>
        {alert.resolvedAt ? (
          <p className="text-sm text-[var(--ok)]">
            ✓ {alert.resolution}
            {alert.resolvedBy ? ` by ${alert.resolvedBy}` : ""}
            {" · "}
            {formatDateTime(alert.resolvedAt)}
            {alert.resolutionNote ? ` — ${alert.resolutionNote}` : ""}
          </p>
        ) : (
          <p className="text-sm text-[var(--fg-dim)]">Open — use Ack / Ignore / Revert above.</p>
        )}
      </section>

      <details className="mt-6">
        <summary className="cursor-pointer text-sm text-[var(--fg-dim)]">Raw actor + log details</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-[var(--bg-elev)] p-3 text-xs">
{JSON.stringify({
  id: alert.id,
  syblogId: alert.syblogId,
  actor: alert.actorRaw,
  diffOld: alert.diffOld,
  diffNew: alert.diffNew,
}, null, 2)}
        </pre>
      </details>
    </div>
  );
}
