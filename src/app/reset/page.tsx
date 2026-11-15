"use client";

import { useEffect, useState } from "react";
import { appUrl, getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { PasswordField } from "@/components/password-field";

/**
 * Set a new password, arrived at from a recovery email.
 *
 * Supabase sends the parent to its own /auth/v1/verify, which redirects here
 * with the session in the URL fragment. The browser client is configured with
 * `detectSessionInUrl`, so by the time it reports a recovery the session is
 * already established and `updateUser` is allowed to change the password.
 *
 * ONLY A RECOVERY LINK UNLOCKS THIS FORM (HAL-1554). The first version of
 * this page accepted any session at all:
 *
 *   onAuthStateChange((_event, session) => { if (session) ready() })
 *
 * which is a different thing entirely, because onAuthStateChange fires
 * INITIAL_SESSION with whatever session the browser already had — this repo
 * says so itself in auth-gate.tsx. On a wall-mounted iPad that restored
 * session is a PARENT'S, so any child could open this page, type a new
 * password twice, and own the parent account: no email, no link, and no
 * knowledge of the old password. Reproduced in a browser, and the
 * `updateUser` call behind it was confirmed to succeed from an ordinary
 * password session.
 *
 * So the check below is on the EVENT, not on the session. A restored session
 * reports INITIAL_SESSION and no longer reaches the form, which closes the
 * only attack a child would actually find: typing the address.
 *
 * BUT THIS CHECK IS NOT A SECURITY BOUNDARY, and an earlier version of this
 * comment wrongly said it was. `redirectType` is `params.type`, read straight
 * out of the URL by auth-js's `_getSessionFromURL` (cited by function rather
 * than line, because `node_modules` line numbers drift on every upgrade) —
 * the access token is
 * validated, the TYPE IS NOT. So a fragment carrying any valid session's
 * tokens plus `type=recovery` emits PASSWORD_RECOVERY for a session that
 * never came near a recovery email. That was demonstrated in a browser
 * against this built export, not reasoned about. And anyone who can read the
 * stored token can call `updateUser` from the console anyway, which is what
 * `src/lib/supabase/client.ts` already says about everything in this bundle:
 * nothing in the client is an authorization decision.
 *
 * THE GUARD IS THE SERVER. `require_current_password` makes Supabase refuse
 * the change for any session that did not arrive by recovery link, whatever
 * the URL claimed. It is set in `supabase/config.toml` — which configures the
 * LOCAL stack only and must never be pushed whole. **Until it is applied to
 * the hosted project, the deployed site has this UX gate and nothing more.**
 * See HAL-1554; do not read this page as protected until that is done.
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
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      // The EVENT, never merely the presence of a session.
      if (event === "PASSWORD_RECOVERY" && session) setState({ kind: "ready" });
    });

    // A link already used, or opened after it expired, yields no session and
    // no error in the URL. Say so rather than spinning forever.
    //
    // But do not say it while a real link is still being checked. Processing a
    // recovery fragment makes a round trip (`_getSessionFromURL` validates the
    // access token against /auth/v1/user before the event is emitted), and on
    // a slow connection that outlasts this timer — which used to show "expired"
    // and then jump to the form, two contradictory things in a row. auth-js
    // clears the hash only once the token has been validated, so a hash that
    // still carries an access token means the answer is genuinely pending.
    const giveUp = setInterval(() => {
      if (window.location.hash.includes("access_token")) return;
      clearInterval(giveUp);
      setState((current) =>
        current.kind === "waiting"
          ? { kind: "expired", detail: "This link has expired or has already been used." }
          : current,
      );
    }, 5000);

    return () => {
      clearInterval(giveUp);
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
          <PasswordField
            id="new-password"
            label="New password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint="At least 8 characters. Tap Show to check it before you save."
          />

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
