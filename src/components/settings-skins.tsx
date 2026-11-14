"use client";

import { useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { MemberBadge, MEMBER_COLOURS, type BadgePerson } from "@/components/member-badge";

/**
 * Letting each person choose their own colour and face.
 *
 * The original brief asks for this — avatar, accent colour, and a child able
 * to photograph their own drawing — and the columns have been sitting empty
 * since the schema was written.
 *
 * Two rules, both deliberate:
 *
 *   A FIXED PALETTE, not a colour wheel. Six hues, each legible with white
 *   text on both page themes. Given free choice a child picks yellow, and
 *   then can't read their own screen.
 *
 *   FREE, never earned. It is tempting to unlock skins with jobs; that turns
 *   personalisation into another thing being traded, which is exactly the
 *   marketplace the rest of this design avoids. Autonomy only motivates when
 *   it is unconditional.
 */

const FACES = ["🦖", "🚀", "⚽️", "🐙", "🦄", "🎸", "🐛", "🍩", "🌵", "🦊", "⭐️", "🙂"];

interface Member extends BadgePerson {
  role: "parent" | "child";
  simple_view?: boolean;
}

export function SettingsSkins({
  members,
  onError,
  onNote,
}: {
  members: Member[];
  onError: (message: string | null) => void;
  onNote: (message: string) => void;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(member: Member, patch: Partial<BadgePerson>) {
    setBusy(true);
    onError(null);
    try {
      const { error } = await getSupabaseClient()
        .from("family_members")
        .update(patch)
        .eq("id", member.id);
      if (error) throw new Error(error.message);
      onNote(`${member.display_name}'s look is saved.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
        Colours and faces
      </h2>
      <p className="mt-1 text-sm text-muted">
        Everyone gets a colour so they can find their own row at a glance.
        Children can change their own whenever they like — it is never
        something to earn.
      </p>

      <ul className="mt-4 flex flex-col gap-3">
        {members.map((m) => (
          <li
            key={m.id}
            className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <MemberBadge person={m} size="lg" />
              <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                {m.display_name}
              </p>
              <button
                type="button"
                onClick={() => setOpenFor(openFor === m.id ? null : m.id)}
                aria-expanded={openFor === m.id}
                className="ml-auto min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
              >
                {openFor === m.id ? "Done" : "Change"}
              </button>
            </div>

            {openFor === m.id && (
              <div className="mt-4 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold">Colour</p>
                  <div className="flex flex-wrap gap-2.5">
                    {MEMBER_COLOURS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        disabled={busy}
                        aria-label={`Use this colour for ${m.display_name}`}
                        aria-pressed={m.accent_color === c}
                        onClick={() => void save(m, { accent_color: c })}
                        className={`h-11 w-11 rounded-full disabled:opacity-60 ${
                          m.accent_color === c
                            ? "ring-2 ring-ink ring-offset-2 ring-offset-[color:var(--color-surface)]"
                            : ""
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold">Face</p>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Use ${m.display_name}'s initial`}
                      aria-pressed={!m.avatar_emoji}
                      onClick={() => void save(m, { avatar_emoji: null })}
                      className={`flex h-11 w-11 items-center justify-center rounded-xl border text-sm font-bold disabled:opacity-60 ${
                        !m.avatar_emoji ? "border-accent bg-accent-wash" : "border-line"
                      }`}
                    >
                      {m.display_name.charAt(0).toUpperCase()}
                    </button>
                    {FACES.map((f) => (
                      <button
                        key={f}
                        type="button"
                        disabled={busy}
                        aria-label={`Use ${f} for ${m.display_name}`}
                        aria-pressed={m.avatar_emoji === f}
                        onClick={() => void save(m, { avatar_emoji: f })}
                        className={`flex h-11 w-11 items-center justify-center rounded-xl border text-xl disabled:opacity-60 ${
                          m.avatar_emoji === f ? "border-accent bg-accent-wash" : "border-line"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted">
                    Drawing your own face comes with the photo work.
                  </p>
                </div>

                {m.role === "child" && (
                  <label className="flex items-start gap-3 rounded-xl border border-line bg-ground p-3">
                    <input
                      type="checkbox"
                      checked={Boolean(m.simple_view)}
                      disabled={busy}
                      onChange={(e) => void save(m, { simple_view: e.target.checked } as never)}
                      className="mt-0.5 h-5 w-5 flex-none"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold">One job at a time</span>
                      <span className="text-xs text-muted">
                        Shows the next job on its own instead of a list. For
                        younger children and anyone still reading slowly.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
