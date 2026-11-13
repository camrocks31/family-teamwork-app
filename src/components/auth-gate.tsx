"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { appUrl, getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

type State =
  | { kind: "loading" }
  | { kind: "unconfigured" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; session: Session };

/**
 * Shows its children only to a signed-in parent.
 *
 * This is presentation, not security. The app is a static export anyone can
 * read and modify before running, so hiding a view protects nothing — the
 * protection is RLS and the SECURITY DEFINER functions, which refuse a caller
 * with no session regardless of what this component renders (HAL-1538 §2.4).
 * The gate exists so the app is coherent, not so it is safe.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  // Whether Supabase is configured is known at render time — the values are
  // inlined into the bundle at build. Deciding it in the initialiser rather
  // than in an effect avoids a pointless second render, and keeps the effect
  // to what it is actually for: subscribing to an external system.
  const [state, setState] = useState<State>(() =>
    isSupabaseConfigured() ? { kind: "loading" } : { kind: "unconfigured" },
  );

  useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const supabase = getSupabaseClient();

    // onAuthStateChange fires INITIAL_SESSION as soon as it subscribes, with
    // the restored session or null, so it alone answers "who is signed in?".
    // Calling getSession() as well would be a second source of truth racing
    // the first — and in headless Chromium it can hang on the session lock,
    // which left the page stuck on "Loading…" until this was removed.
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setState(
          session ? { kind: "signed-in", session } : { kind: "signed-out" },
        );
      },
    );

    return () => subscription.subscription.unsubscribe();
  }, []);

  if (state.kind === "loading") {
    return (
      <output
        aria-live="polite"
        className="flex min-h-screen items-center justify-center text-muted"
      >
        Loading…
      </output>
    );
  }

  if (state.kind === "unconfigured") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold">
          Not set up yet
        </h1>
        <p className="text-muted">
          This copy of the hub has no Supabase connection configured. Copy{" "}
          <code className="rounded bg-accent-wash px-1">.env.local.example</code>{" "}
          to <code className="rounded bg-accent-wash px-1">.env.local</code> and
          fill it in.
        </p>
      </main>
    );
  }

  if (state.kind === "signed-out") {
    return <SignInForm />;
  }

  return <>{children}</>;
}

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Resetting is a mode of this form rather than a separate page, so the email
  // already typed carries over and nobody has to find their way back.
  const [mode, setMode] = useState<"sign-in" | "forgot">("sign-in");
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await getSupabaseClient().auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      // Deliberately not "no account with that email": that would tell anyone
      // who can open the public URL which addresses have accounts here.
      setError("That email and password did not match. Please try again.");
      setBusy(false);
    }
    // On success the auth listener in AuthGate swaps the view; no redirect.
  }

  async function handleReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: resetError } = await getSupabaseClient().auth.resetPasswordForEmail(
      email,
      { redirectTo: appUrl("/reset/") },
    );
    setBusy(false);
    if (resetError) {
      // Rate limiting is the one failure worth naming, because waiting is the
      // remedy and a parent would otherwise keep pressing the button.
      setError(
        /rate|limit|seconds/i.test(resetError.message)
          ? "Too many requests just now. Please wait a minute and try again."
          : "That did not work. Please try again in a moment.",
      );
      return;
    }
    // Said the same way whether or not the address has an account: on a public
    // URL, "no such account" would let anyone test which addresses exist.
    setSent(true);
  }

  if (mode === "forgot") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
            Reset your password
          </h1>
          <p className="mt-1 text-muted">
            We will email you a link to choose a new one.
          </p>
        </div>

        {sent ? (
          <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6">
            <p role="status">
              If an account exists for that address, a reset link is on its way.
              It can only be used once, and it does not last long.
            </p>
            <button
              type="button"
              onClick={() => {
                setMode("sign-in");
                setSent(false);
              }}
              className="min-h-[52px] rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleReset}
            className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6"
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="reset-email" className="text-sm font-semibold">
                Email
              </label>
              <input
                id="reset-email"
                name="reset-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-xl border border-attention-line bg-attention-wash px-3 py-2 text-sm text-attention-ink"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="min-h-[52px] rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode("sign-in");
                setError(null);
              }}
              className="min-h-[44px] text-sm font-semibold text-accent underline underline-offset-4"
            >
              Back to sign in
            </button>
          </form>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
          Our Family Hub
        </h1>
        <p className="mt-1 text-muted">Parents sign in here.</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-semibold">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-semibold">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
          />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-attention-line bg-attention-wash px-3 py-2 text-sm text-attention-ink"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="min-h-[52px] rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode("forgot");
            setError(null);
          }}
          className="min-h-[44px] text-sm font-semibold text-accent underline underline-offset-4"
        >
          Forgot your password?
        </button>
      </form>

      <p className="text-center text-sm text-muted">
        There is no sign-up here on purpose. A parent creates accounts; the
        children sign in on the family iPad with their own profile and PIN.
      </p>
    </main>
  );
}
