"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  alertId: string;
  canRevert: boolean;
  accountId: string;
  zoneId: string | null;
}

export default function AlertRowActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function resolve(resolution: "acknowledged" | "ignored") {
    setBusy(resolution);
    setErr(null);
    try {
      const res = await fetch(`/api/alerts/${props.alertId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution }),
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

  async function revert() {
    if (!props.zoneId) return;
    setBusy("revert");
    setErr(null);
    try {
      const res = await fetch(
        `/api/accounts/${props.accountId}/zones/${props.zoneId}/revert`,
        { method: "POST" }
      );
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

  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-1">
      <div className="flex gap-2">
        {props.canRevert && (
          <button
            onClick={revert}
            disabled={busy !== null}
            className="rounded border border-[var(--warn)] px-2 py-0.5 text-xs text-[var(--warn)] disabled:opacity-50"
          >
            {busy === "revert" ? "Reverting…" : "Revert"}
          </button>
        )}
        <button
          onClick={() => resolve("acknowledged")}
          disabled={busy !== null}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-elev)] disabled:opacity-50"
        >
          {busy === "acknowledged" ? "…" : "Ack"}
        </button>
        <button
          onClick={() => resolve("ignored")}
          disabled={busy !== null}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--fg-dim)] hover:bg-[var(--bg-elev)] disabled:opacity-50"
        >
          {busy === "ignored" ? "…" : "Ignore"}
        </button>
      </div>
      {err && <span className="text-xs text-[var(--crit)]">{err}</span>}
    </div>
  );
}
