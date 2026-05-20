import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "BMAsia SYB Monitor",
  description: "Watch + auto-revert unauthorized changes to Soundtrack Your Brand accounts.",
};

async function NavBar() {
  const session = await getSession();
  return (
    <header className="border-b border-[var(--border)] bg-[var(--bg-elev)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-base font-semibold tracking-tight no-underline text-[var(--fg)]">
          BMAsia SYB Monitor
        </Link>
        {session.isLoggedIn ? (
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/dashboard" className="text-[var(--fg-dim)] no-underline hover:text-[var(--fg)]">Dashboard</Link>
            <Link href="/alerts" className="text-[var(--fg-dim)] no-underline hover:text-[var(--fg)]">Alerts</Link>
            <span className="text-[var(--fg-dim)]">{session.email}</span>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="text-[var(--fg-dim)] hover:text-[var(--fg)]">Sign out</button>
            </form>
          </nav>
        ) : (
          <Link href="/login" className="text-sm text-[var(--fg-dim)] no-underline hover:text-[var(--fg)]">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavBar />
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
