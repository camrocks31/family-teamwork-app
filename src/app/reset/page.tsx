"use client";

import { useEffect, useState } from "react";
import { appUrl, getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Set a new password, arrived at from a recovery email.
 *
 * Supabase sends the parent to its own /auth/v1/verify, which redirects here
 * with the session in the URL fragment. The browser client is configured with
 * `detectSessionInUrl`, so by the time it reports a session the recovery is
 * already established and `updateUser` is allowed to change the password.
 *
 * All of this is client-side because there is no server: the page is a static
 * file. Nothing here decides whether the password may change — Supabase does,
 * by checking the recovery token it issued.
 */

type State =
  | { kind: "waiting" }
  | { kind: "ready" }
  | { kind: "expired"; detail: string }
  | { kind: "done" };

/** A dead link arrives as parameters, not as a thrown error. */
function errorFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  const description = hash.get("error_description") ?? query.get("error_description");
  if (description) return description.replace(/\+/g, " ");
  return hash.get("error") ?? query.get("error");
}

export default function ResetPasswordPage() {
  // Whether Supabase is configured is a build-time constant, so it is the
  // same on the prerendered HTML and on the client — safe to decide here.
  // Whether the LINK is good is not: it lives in the URL fragment, which the
  // server never sees, so that decision has to wait for the effect below.
  const [state, setState] = useState<State>(() =>
    isSupabaseConfigured()
      ? { kind: "waiting" }
      : { kind: "expired", detail: "This hub has no Supabase connection configured." },
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const urlError = errorFromUrl();
    if (urlError) {
      // Deliberate, and the one place this rule has to give: the fragment
      // carrying Supabase's error is never sent to the server, so the
      // prerendered HTML cannot contain it. The first paint is necessarily
      // neutral and the truth arrives after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ kind: "expired", detail: urlError });
      return;
    }

    const supabase = getSupabaseClient();
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setState({ kind: "ready" });
    });

    // A link already used, or opened after it expired, yields no session and
    // no error in the URL. Say so rather than spinning forever.
    const giveUp = setTimeout(() => {
      setState((current) =>
        current.kind === "waiting"
          ? { kind: "expired", detail: "This link has expired or has already been used." }
          : current,
      );
    }, 5000);

    return () => {
      clearTimeout(giveUp);
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Checked here so the message is kind, and by Supabase regardless.
    if (password.length < 8) {
      setError("Please use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Those two passwords do not match.");
      return;
    }

    setBusy(true);
    const { error: updateError } = await getSupabaseClient().auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setState({ kind: "done" });
  }

  const home = appUrl("/");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
          Choose a new password
        </h1>
        {state.kind === "ready" && (
          <p className="mt-1 text-muted">Then you will be signed in.</p>
        )}
      </div>

      {state.kind === "waiting" && (
        <output aria-live="polite" className="text-muted">
          Checking your link…
        </output>
      )}

      {state.kind === "expired" && (
        <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <p role="alert" className="text-attention-ink">
            {state.detail}
          </p>
          <p className="text-sm text-muted">
            Reset links can be used once and do not last long. Ask for a new one
            from the sign-in page.
          </p>
          <a
            href={home}
            className="min-h-[52px] rounded-2xl bg-accent px-4 text-center font-[family-name:var(--font-display)] text-lg font-semibold leading-[52px] text-white"
          >
            Back to sign in
          </a>
        </div>
      )}

      {state.kind === "done" && (
        <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6">
          <p role="status">Your password is changed, and you are signed in.</p>
          <a
            href={home}
            className="min-h-[52px] rounded-2xl bg-accent px-4 text-center font-[family-name:var(--font-display)] text-lg font-semibold leading-[52px] text-white"
          >
            Go to the hub
          </a>
        </div>
      )}

      {state.kind === "ready" && (
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-6"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-password" className="text-sm font-semibold">
              New password
            </label>
            <input
              id="new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm-password" className="text-sm font-semibold">
              Type it again
            </label>
            <input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {busy ? "Saving…" : "Save new password"}
          </button>
        </form>
      )}
    </main>
  );
}
