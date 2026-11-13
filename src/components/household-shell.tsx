"use client";

import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";

type Household = { id: string; name: string; timezone: string };
type Member = { id: string; display_name: string; role: string; avatar_emoji: string | null };

/**
 * The guarded shell. Slice 1 only has to prove the chain works end to end: a
 * signed-in parent reaches their own household's rows through RLS, and nobody
 * else's. The dashboard itself is slice 6.
 */
export function HouseholdShell() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseClient();
    (async () => {
      const [householdResult, memberResult] = await Promise.all([
        supabase.from("households").select("id, name, timezone").maybeSingle(),
        supabase
          .from("family_members")
          .select("id, display_name, role, avatar_emoji")
          .order("role")
          .order("display_name"),
      ]);
      if (householdResult.error) return setError(householdResult.error.message);
      if (memberResult.error) return setError(memberResult.error.message);
      setHousehold(householdResult.data);
      setMembers(memberResult.data ?? []);
    })();
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
            {household?.name ?? "Our Family Hub"}
          </h1>
          {household && (
            <p className="mt-1 text-sm text-muted">{household.timezone}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => getSupabaseClient().auth.signOut()}
          className="min-h-[44px] rounded-xl border border-line bg-surface px-4 text-sm font-semibold"
        >
          Sign out
        </button>
      </header>

      {error && (
        <p
          role="alert"
          className="mt-6 rounded-[var(--radius-card)] border border-attention-line bg-attention-wash px-4 py-3 text-attention-ink"
        >
          {error}
        </p>
      )}

      <section aria-labelledby="family-heading" className="mt-8">
        <h2
          id="family-heading"
          className="font-[family-name:var(--font-display)] text-xs font-semibold uppercase tracking-wider text-muted"
        >
          Family
        </h2>
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-3 py-4"
            >
              <span aria-hidden="true" className="text-2xl">
                {member.avatar_emoji ?? "🙂"}
              </span>
              <span className="font-[family-name:var(--font-display)] text-base font-semibold">
                {member.display_name}
              </span>
              <span className="text-xs text-muted">{member.role}</span>
            </li>
          ))}
        </ul>
        {members.length === 0 && !error && (
          <p className="mt-3 text-muted">No family members yet.</p>
        )}
      </section>

      <p className="mt-10 rounded-[var(--radius-card)] border border-accent-line bg-accent-wash px-4 py-3 text-sm text-accent-strong">
        Foundation slice. Tasks, rooms and activity readiness arrive in the next
        slices.
      </p>
    </main>
  );
}
