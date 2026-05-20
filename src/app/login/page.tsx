import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  const session = await getSession();
  if (session.isLoggedIn) redirect("/dashboard");
  return (
    <div className="mx-auto max-w-md py-12">
      <h1 className="mb-2 text-2xl font-semibold">Sign in</h1>
      <p className="mb-8 text-sm text-[var(--fg-dim)]">
        BMAsia team only. Email must be on the allowlist.
      </p>
      <LoginForm />
    </div>
  );
}
