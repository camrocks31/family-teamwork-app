"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/auth-gate";
import { getSupabaseClient } from "@/lib/supabase/client";
import { householdToday } from "@/lib/dashboard";
import { TaskConflictError, tasks as taskApi } from "@/lib/tasks";

/**
 * The dog's day.
 *
 * The brief asks for four things tracked separately — food, water, outside,
 * and picking up after her — shared so anyone may record them, and it names
 * the failure to design against: "avoid accidental duplicate feeding by
 * clearly showing who fed her and when."
 *
 * So WHO and WHEN are the loudest thing on each row, not a detail behind a
 * tap. A child who cannot tell whether she has been fed will feed her again,
 * and the dog does not refuse.
 *
 * Picking up after her allows "not needed", because some mornings she simply
 * does not go — that permission comes from the task's own revision
 * (not_needed_permitted) rather than from a title match here.
 */

interface CareTask {
  instance_id: string;
  title: string;
  state: string;
  version: number;
  by: string | null;
  at: string | null;
  notNeeded: boolean;
  notNeededPermitted: boolean;
  criteria: string[];
}

interface Pet {
  name: string;
  avatar: string | null;
}

export default function LucyPage() {
  return (
    <AuthGate>
      <PetCare />
    </AuthGate>
  );
}

function PetCare() {
  const [pet, setPet] = useState<Pet | null>(null);
  const [tasks, setTasks] = useState<CareTask[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const supabase = getSupabaseClient();

    const { data: household } = await supabase
      .from("households")
      .select("timezone")
      .maybeSingle();
    const tz = household?.timezone ?? "UTC";
    setTimezone(tz);

    const { data, error: loadError } = await supabase
      .from("task_instances")
      .select(
        // Every foreign key is named. task_instances reaches family_members
        // by four constraints (completed_by, submitted_by, not_applicable_by,
        // subject_member_id) and task_definitions by three, so an
        // unqualified embed is ambiguous and PostgREST answers PGRST201.
        `id, state, version, completed_at, not_applicable_reason, not_applicable_at,
         completed_by_member:family_members!task_instances_completed_by_fkey ( display_name ),
         task_definitions!task_instances_definition_id_fkey!inner (
           pet_id,
           pets!task_definitions_pet_id_fkey ( name, avatar_emoji )
         ),
         task_definition_revisions!task_instances_definition_revision_id_fkey!inner (
           title, not_needed_permitted,
           task_definition_criteria!task_definition_criteria_revision_id_fkey ( text, display_order )
         )`,
      )
      .not("task_definitions.pet_id", "is", null)
      .eq("occurrence_date", await householdToday())
      .order("id");
    if (loadError) throw new Error(loadError.message);

    type Row = {
      id: string;
      state: string;
      version: number;
      completed_at: string | null;
      not_applicable_reason: string | null;
      not_applicable_at: string | null;
      completed_by_member: { display_name: string } | null;
      task_definitions: {
        pets: { name: string; avatar_emoji: string | null } | null;
      } | null;
      task_definition_revisions: {
        title: string;
        not_needed_permitted: boolean;
        task_definition_criteria: { text: string; display_order: number }[];
      };
    };

    const rows = (data as unknown as Row[]) ?? [];
    const firstPet = rows.find((r) => r.task_definitions?.pets)?.task_definitions?.pets;
    setPet(firstPet ? { name: firstPet.name, avatar: firstPet.avatar_emoji } : null);

    setTasks(
      rows.map((r) => ({
        instance_id: r.id,
        title: r.task_definition_revisions.title,
        state: r.state,
        version: r.version,
        by: r.completed_by_member?.display_name ?? null,
        at: r.completed_at ?? r.not_applicable_at,
        notNeeded: r.not_applicable_reason === "not_needed",
        notNeededPermitted: r.task_definition_revisions.not_needed_permitted,
        criteria: [...r.task_definition_revisions.task_definition_criteria]
          .sort((a, b) => a.display_order - b.display_order)
          .map((c) => c.text),
      })),
    );
  }, []);

  useEffect(() => {
    const supabase = getSupabaseClient();
    const refresh = () =>
      load()
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    void refresh();

    // Shared care, so another device recording the feed has to show up here
    // without anybody reloading — that is the whole anti-double-feeding
    // mechanism.
    const channel = supabase
      .channel("pet-care")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_instances" },
        () => void refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  async function act(task: CareTask, run: () => Promise<unknown>) {
    setBusyId(task.instance_id);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(
        e instanceof TaskConflictError
          ? "Somebody else just did this one."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusyId(null);
    }
  }

  function timeOf(iso: string | null): string | null {
    if (!iso) return null;
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  }

  const outstanding = tasks.filter((t) => t.state !== "completed" && !t.notNeeded);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-6">
      <Link
        href="/"
        className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-accent"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        The house
      </Link>

      <h1 className="mt-2 flex items-center gap-3 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
        <span aria-hidden="true">{pet?.avatar ?? "🐕"}</span>
        {pet?.name ?? "The dog"}
      </h1>
      <p className="mt-1 text-muted">
        {loading
          ? "Looking…"
          : tasks.length === 0
            ? "Nothing needed today."
            : outstanding.length === 0
              ? "All looked after."
              : `${outstanding.length} still to do`}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-[var(--radius-card)] border border-attention-line bg-attention-wash px-4 py-3 text-attention-ink"
        >
          {error}
        </p>
      )}

      <ul className="mt-6 flex flex-col gap-3">
        {tasks.map((t) => {
          const done = t.state === "completed";
          const settled = done || t.notNeeded;
          const when = timeOf(t.at);
          return (
            <li
              key={t.instance_id}
              className={`rounded-[var(--radius-card)] border p-4 ${
                settled
                  ? "border-[color:var(--color-done)]/30 bg-done-wash"
                  : "border-line bg-surface"
              }`}
            >
              <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                {t.title}
              </p>

              {/* The anti-double-feeding line. Loud, and never behind a tap. */}
              {settled ? (
                <p className="mt-1 font-semibold text-[color:var(--color-done)]">
                  {t.notNeeded
                    ? "Not needed today"
                    : `Done${t.by ? ` by ${t.by}` : ""}${when ? ` at ${when}` : ""}`}
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted">Not yet today</p>
              )}

              {!settled && t.criteria.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {t.criteria.map((c, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <span aria-hidden="true" className="text-muted">
                        ·
                      </span>
                      {c}
                    </li>
                  ))}
                </ul>
              )}

              {!settled && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyId === t.instance_id}
                    onClick={() =>
                      void act(t, () => taskApi.complete(t.instance_id, t.version))
                    }
                    className="min-h-[52px] flex-1 rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white disabled:opacity-60"
                  >
                    {busyId === t.instance_id ? "Saving…" : "Done"}
                  </button>
                  {t.notNeededPermitted && (
                    <button
                      type="button"
                      disabled={busyId === t.instance_id}
                      onClick={() =>
                        void act(t, () => taskApi.markNotNeeded(t.instance_id, t.version))
                      }
                      className="min-h-[52px] rounded-2xl border border-line px-4 font-semibold disabled:opacity-60"
                    >
                      She didn&rsquo;t need to
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
