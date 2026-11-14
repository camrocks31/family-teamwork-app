"use client";

import { useEffect, useState } from "react";
import {
  clearActor,
  getActor,
  isEnrolled,
  signInWithPin,
  type Actor,
} from "@/lib/kiosk";

export interface Person {
  id: string;
  display_name: string;
  role: "parent" | "child";
  avatar_emoji: string | null;
}

/**
 * "I'm Desmond" — pick a face, type four digits.
 *
 * This is the whole point of a shared tablet: the hub belongs to the house,
 * not to whoever last signed in, and a child must be able to say who they are
 * without a password, an email address or an account. The PIN is attribution,
 * not authorisation — it answers "who pressed done?", and it is checked by the
 * database, which counts wrong attempts and locks the profile after too many
 * so a sibling cannot guess their way in.
 *
 * Choosing a profile NEVER grants parent powers. That is enforced in the
 * database, not here; this component could be rewritten by anyone reading the
 * page source and it would change nothing.
 */
export function WhoAmI({
  people,
  onChange,
}: {
  people: Person[];
  onChange?: (actor: Actor | null) => void;
}) {
  const [actor, setActor] = useState<Actor | null>(null);
  const [choosing, setChoosing] = useState<Person | null>(null);
  const [enrolled, setEnrolled] = useState(true);

  useEffect(() => {
    // Deliberate. Both of these live in localStorage, which the server cannot
    // see, so a statically prerendered page must paint "nobody is signed in"
    // and correct itself after mount. Deciding it in the state initialiser
    // instead would mismatch the prerendered HTML on hydration.
    const current = getActor();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActor(current);
    setEnrolled(isEnrolled());
    onChange?.(current);
    // onChange is a callback prop; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function adopt(next: Actor | null) {
    setActor(next);
    setChoosing(null);
    onChange?.(next);
  }

  if (actor) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
        <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
          Hello, {actor.displayName}
        </p>
        <button
          type="button"
          onClick={() => {
            clearActor();
            adopt(null);
          }}
          className="ml-auto min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
        >
          Not {actor.displayName}?
        </button>
      </div>
    );
  }

  if (choosing) {
    return (
      <PinPad
        person={choosing}
        onCancel={() => setChoosing(null)}
        onSuccess={adopt}
      />
    );
  }

  return (
    <section
      aria-label="Who is using this?"
      className="rounded-[var(--radius-card)] border border-line bg-surface p-5"
    >
      <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
        Who are you?
      </h2>
      {!enrolled && (
        <p className="mt-2 text-sm text-muted">
          This device has not been set up yet. A parent can do that in Settings,
          and then everyone can sign in here with a PIN.
        </p>
      )}
      <ul className="mt-4 flex flex-wrap gap-3">
        {people.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={!enrolled}
              onClick={() => setChoosing(p)}
              className="flex min-h-[96px] min-w-[96px] flex-col items-center justify-center gap-1 rounded-2xl border border-line bg-ground px-4 py-3 disabled:opacity-50"
            >
              <span aria-hidden="true" className="text-3xl">
                {p.avatar_emoji ?? "🙂"}
              </span>
              <span className="font-[family-name:var(--font-display)] font-semibold">
                {p.display_name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Four big digits, because the people using it are seven. */
function PinPad({
  person,
  onCancel,
  onSuccess,
}: {
  person: Person;
  onCancel: () => void;
  onSuccess: (actor: Actor) => void;
}) {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    setMessage(null);
    const result = await signInWithPin(person, value);
    setBusy(false);
    setPin("");

    if (result.ok) {
      onSuccess(result.actor);
      return;
    }
    if (result.reason === "wrong_pin") {
      setMessage(
        result.attemptsLeft > 0
          ? `That is not the right PIN. ${result.attemptsLeft} ${
              result.attemptsLeft === 1 ? "try" : "tries"
            } left.`
          : "That is not the right PIN.",
      );
      return;
    }
    if (result.reason === "locked") {
      setMessage("Too many tries. Ask a grown-up to help.");
      return;
    }
    if (result.reason === "no_pin") {
      setMessage("No PIN has been set for this profile yet.");
      return;
    }
    setMessage(result.message);
  }

  function press(digit: string) {
    if (busy) return;
    const next = (pin + digit).slice(0, 4);
    setPin(next);
    // Four digits is the whole PIN, so there is nothing to confirm.
    if (next.length === 4) void submit(next);
  }

  return (
    <section
      aria-label={`PIN for ${person.display_name}`}
      className="rounded-[var(--radius-card)] border border-line bg-surface p-5"
    >
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="text-3xl">
          {person.avatar_emoji ?? "🙂"}
        </span>
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          {person.display_name}, what is your PIN?
        </h2>
      </div>

      <p className="mt-4 flex justify-center gap-3" aria-live="polite">
        <span className="sr-only">{pin.length} of 4 digits entered</span>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`h-5 w-5 rounded-full border-2 ${
              i < pin.length
                ? "border-accent bg-accent"
                : "border-line bg-transparent"
            }`}
          />
        ))}
      </p>

      {message && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-attention-line bg-attention-wash px-3 py-2 text-center text-sm text-attention-ink"
        >
          {message}
        </p>
      )}

      <div className="mx-auto mt-5 grid max-w-[280px] grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            disabled={busy}
            onClick={() => press(d)}
            className="min-h-[64px] rounded-2xl border border-line bg-ground font-[family-name:var(--font-display)] text-2xl font-semibold disabled:opacity-60"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[64px] rounded-2xl border border-line text-sm font-semibold"
        >
          Back
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => press("0")}
          className="min-h-[64px] rounded-2xl border border-line bg-ground font-[family-name:var(--font-display)] text-2xl font-semibold disabled:opacity-60"
        >
          0
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setPin((p) => p.slice(0, -1))}
          aria-label="Delete the last digit"
          className="min-h-[64px] rounded-2xl border border-line text-xl font-semibold disabled:opacity-60"
        >
          ⌫
        </button>
      </div>
    </section>
  );
}
