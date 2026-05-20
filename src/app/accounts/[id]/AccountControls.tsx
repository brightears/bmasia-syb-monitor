"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface ZoneView {
  id: string;
  name: string;
  monitored: boolean;
  approvedPlayFromId: string | null;
  approvedPlayFromName: string | null;
  lastSeenPlayFromId: string | null;
  lastSeenPlayFromName: string | null;
  baselineCapturedAt: string | null;
  driftDetectedAt: string | null;
  staffControlLocked: boolean;
}

interface Props {
  accountId: string;
  monitored: boolean;
  autoRevertEnabled: boolean;
  preventionApplied: boolean;
  zones: ZoneView[];
}

export default function AccountControls(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function patchAccount(payload: Record<string, unknown>, busyLabel: string) {
    setBusy(busyLabel);
    setErr(null);
    try {
      const res = await fetch(`/api/accounts/${props.accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function patchZone(zoneId: string, payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setErr(null);
    try {
      const res = await fetch(`/api/accounts/${props.accountId}/zones/${zoneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function captureBaseline(zoneId: string) {
    await patchZone(zoneId, { captureBaseline: true }, `cap:${zoneId}`);
  }

  async function applyPrevention() {
    setBusy("prevent");
    setErr(null);
    try {
      const res = await fetch(`/api/accounts/${props.accountId}/prevention`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy("sync");
    setErr(null);
    try {
      const res = await fetch(`/api/accounts/${props.accountId}/sync`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revertNow(zoneId: string) {
    setBusy(`revert:${zoneId}`);
    setErr(null);
    try {
      const res = await fetch(`/api/accounts/${props.accountId}/zones/${zoneId}/revert`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const anyBaselineCaptured = props.zones.some((z) => z.monitored && z.approvedPlayFromId);

  return (
    <div className="flex flex-col gap-6">
      {err && (
        <div className="rounded border border-[var(--crit)] bg-[var(--crit)]/10 px-3 py-2 text-sm text-[var(--crit)]">
          {err}
        </div>
      )}

      {/* Account-level toggles */}
      <section className="rounded border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <h2 className="mb-3 text-sm font-medium">Account controls</h2>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={props.monitored}
              onChange={(e) => patchAccount({ monitored: e.target.checked }, "monitor")}
              disabled={busy !== null}
            />
            Monitored
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={props.autoRevertEnabled}
              onChange={(e) => patchAccount({ autoRevertEnabled: e.target.checked }, "auto")}
              disabled={busy !== null || !props.monitored || !anyBaselineCaptured}
              title={!anyBaselineCaptured ? "Capture at least one baseline first" : ""}
            />
            Auto-revert on drift
          </label>
          <button
            onClick={applyPrevention}
            disabled={busy !== null || !props.monitored}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--bg)] disabled:opacity-50"
          >
            {busy === "prevent" ? "Applying…" : props.preventionApplied ? "Re-apply lockdown" : "Apply lockdown"}
          </button>
          <button
            onClick={syncNow}
            disabled={busy !== null || !props.monitored}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--bg)] disabled:opacity-50"
          >
            {busy === "sync" ? "Syncing…" : "Sync now"}
          </button>
        </div>
        <p className="mt-3 text-xs text-[var(--fg-dim)]">
          <b>Apply lockdown</b> turns on the account-wide protection layer in
          SYB — staff can&apos;t edit playlists, discover new music, block tracks,
          or unpair devices from the apps. Activity log is enabled so changes
          are visible. Combined with auto-revert, this catches and reverses
          any drift within 10 minutes.
        </p>
      </section>

      {/* Zones */}
      <section className="rounded border border-[var(--border)] bg-[var(--bg-elev)] p-4">
        <h2 className="mb-3 text-sm font-medium">Zones</h2>
        {props.zones.length === 0 ? (
          <p className="text-sm text-[var(--fg-dim)]">
            No zones synced yet. Use <span className="text-[var(--fg)]">Sync now</span>.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--fg-dim)]">
                <th className="border-b border-[var(--border)] py-2 pr-3">Zone</th>
                <th className="border-b border-[var(--border)] py-2 pr-3">Monitored</th>
                <th className="border-b border-[var(--border)] py-2 pr-3">Approved baseline</th>
                <th className="border-b border-[var(--border)] py-2 pr-3">Last seen</th>
                <th className="border-b border-[var(--border)] py-2 pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {props.zones.map((z) => {
                const drift =
                  z.approvedPlayFromId &&
                  z.lastSeenPlayFromId &&
                  z.lastSeenPlayFromId !== z.approvedPlayFromId;
                return (
                  <tr key={z.id} className="align-top">
                    <td className="py-2 pr-3">
                      <div>{z.name}</div>
                      <div className="text-xs text-[var(--fg-dim)]">{z.id}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="checkbox"
                        checked={z.monitored}
                        onChange={(e) => patchZone(z.id, { monitored: e.target.checked }, `m:${z.id}`)}
                        disabled={busy !== null || !props.monitored}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      {z.approvedPlayFromName ? (
                        <span className="text-[var(--ok)]">{z.approvedPlayFromName}</span>
                      ) : (
                        <span className="text-[var(--fg-dim)]">— not captured —</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {z.lastSeenPlayFromName ?? "—"}
                      {drift && (
                        <div className="text-xs text-[var(--warn)]">drift!</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => captureBaseline(z.id)}
                          disabled={busy !== null || !z.monitored}
                          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg)] disabled:opacity-50"
                          title="Lock the current playFrom as the approved baseline"
                        >
                          {busy === `cap:${z.id}` ? "…" : z.approvedPlayFromId ? "Re-capture" : "Capture baseline"}
                        </button>
                        {z.approvedPlayFromId && drift && (
                          <button
                            onClick={() => revertNow(z.id)}
                            disabled={busy !== null}
                            className="rounded border border-[var(--warn)] px-2 py-0.5 text-xs text-[var(--warn)] hover:bg-[var(--bg)] disabled:opacity-50"
                          >
                            {busy === `revert:${z.id}` ? "Reverting…" : "Revert now"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
