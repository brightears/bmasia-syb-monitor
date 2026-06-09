"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Per-row "Remove" action on the dashboard. Inline two-step confirm so a
 * single mis-click can't delete an account. Hits DELETE /api/accounts/[id]
 * (local-only — no SYB mutation) and refreshes the list on success.
 */
export default function DeleteAccountButton({
  accountId,
  businessName,
}: {
  accountId: string;
  businessName: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/accounts/${accountId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed (${res.status})`);
      }
      setConfirming(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--fg-dim)] hover:border-[var(--crit)] hover:text-[var(--crit)]"
        title={`Remove ${businessName} from the monitor`}
      >
        Remove
      </button>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <span className="text-xs text-[var(--crit)]">{err ?? "Remove?"}</span>
      <button
        onClick={remove}
        disabled={busy}
        className="rounded border border-[var(--crit)] bg-[var(--crit)]/10 px-2 py-0.5 text-xs text-[var(--crit)] hover:bg-[var(--crit)]/20 disabled:opacity-50"
      >
        {busy ? "Removing…" : "Confirm"}
      </button>
      <button
        onClick={() => {
          setConfirming(false);
          setErr(null);
        }}
        disabled={busy}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--bg-elev)] disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  );
}
