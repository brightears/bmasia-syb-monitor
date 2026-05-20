"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface SybAccount {
  id: string;
  businessName: string;
}

export default function AddAccountButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<SybAccount[] | null>(null);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || accounts) return;
    void (async () => {
      try {
        const res = await fetch("/api/syb/accounts");
        if (!res.ok) throw new Error(`SYB account list failed (${res.status})`);
        const json = (await res.json()) as { accounts: SybAccount[] };
        setAccounts(json.accounts);
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [open, accounts]);

  async function onPick(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Add failed (${res.status})`);
      }
      const json = (await res.json()) as { id: string };
      setOpen(false);
      router.push(`/accounts/${json.id}`);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const filtered = (accounts ?? []).filter((a) =>
    a.businessName.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
      >
        Add account
      </button>
      {open && (
        <div
          className="fixed inset-0 z-10 flex items-start justify-center bg-black/60 p-8"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Pick a SYB account</h2>
              <button onClick={() => setOpen(false)} className="text-[var(--fg-dim)]">✕</button>
            </div>
            <input
              type="text"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="mb-3 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
            />
            {err && <p className="mb-3 text-sm text-[var(--crit)]">{err}</p>}
            {accounts === null && !err && (
              <p className="text-sm text-[var(--fg-dim)]">Loading from SYB…</p>
            )}
            {accounts !== null && (
              <ul className="max-h-96 overflow-y-auto divide-y divide-[var(--border)]">
                {filtered.map((a) => (
                  <li key={a.id} className="flex items-center justify-between py-2">
                    <div>
                      <div>{a.businessName}</div>
                    </div>
                    <button
                      onClick={() => onPick(a.id)}
                      disabled={busyId === a.id}
                      className="rounded border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--bg)] disabled:opacity-50"
                    >
                      {busyId === a.id ? "Adding…" : "Add"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  );
}
