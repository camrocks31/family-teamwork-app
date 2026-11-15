"use client";

import { useState } from "react";

/**
 * A password box you can actually read.
 *
 * Every password field in this app was write-only, which is a bad trade
 * anywhere and a worse one here: the hub is used on a wall-mounted iPad, where
 * typing is slow and wrong, and the people typing include a seven-year-old.
 * Hiding what you typed does not protect you from anyone — the person who can
 * see your screen is standing next to you — and it costs you a retype every
 * time your thumb lands between two keys.
 *
 * It also removes the reason the reset page asked for the password twice. A
 * confirmation box exists to catch a typo you were not allowed to see; let
 * people see it and the second box is just a second chance to make the same
 * mistake.
 *
 * Starts hidden, because a password on a kitchen wall should not be readable
 * from the doorway by default — showing it is a deliberate tap.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: string;
}) {
  const [shown, setShown] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {hint && <p className="text-sm text-muted">{hint}</p>}
      <div className="relative">
        <input
          id={id}
          name={id}
          // The whole feature, and the reason this is a client component.
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[48px] w-full rounded-xl border border-line bg-ground pl-3 pr-[4.5rem] text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
        />
        <button
          type="button"
          // Never a submit button: it sits inside a form, and a stray Enter
          // on a tablet keyboard would otherwise toggle instead of sign in.
          onClick={() => setShown((current) => !current)}
          aria-pressed={shown}
          // Says what the BUTTON does, not what the state is — what a screen
          // reader user needs when they can see neither.
          //
          // And deliberately WITHOUT the word "password": two controls in one
          // group both labelled "…password" are ambiguous to anybody
          // navigating by label, which is also why every getByLabel("Password")
          // in the test suite matched this button as well as the input.
          aria-label={shown ? "Hide what you typed" : "Show what you typed"}
          className="absolute right-1.5 top-1/2 min-h-[40px] -translate-y-1/2 rounded-lg px-3 text-sm font-semibold text-accent"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}
