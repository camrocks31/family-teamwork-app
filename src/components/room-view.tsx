"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";
import { evaluateSpaceStatus, type SpaceResult, type SpaceStatus } from "@/lib/readiness";

/**
 * One room, and exactly what is left in it.
 *
 * This is where a blocker on the dashboard lands. The brief's test is that a
 * child taps "Boys' Bedroom needs attention" and arrives somewhere that tells
 * them what to actually do — so the criteria are on screen, not just the task
 * titles.
 */

interface RoomTask {
  instance_id: string;
  title: string;
  state: string;
  satisfaction: string;
  correction_note: string | null;
  criteria: string[];
}

const LABEL: Record<SpaceStatus, string> = {
  ready: "Ready",
  in_progress: "In progress",
  awaiting_review: "Awaiting review",
  needs_attention: "Needs attention",
};

export function RoomView() {
  const spaceId = useSearchParams().get("space");
  const [status, setStatus] = useState<SpaceResult | null>(null);
  const [tasks, setTasks] = useState<RoomTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!spaceId) return;
    const supabase = getSupabaseClient();

    const load = async () => {
      try {
        setStatus(await evaluateSpaceStatus(spaceId));

        const { data, error: taskError } = await supabase
          .from("task_instances")
          .select(
            `id, state, correction_note,
             task_definitions!inner ( location_space_id ),
             task_definition_revisions!inner ( title, task_definition_criteria ( text, display_order ) )`,
          )
          .eq("task_definitions.location_space_id", spaceId)
          .order("id");
        if (taskError) throw new Error(taskError.message);

        type Row = {
          id: string;
          state: string;
          correction_note: string | null;
          task_definition_revisions: {
            title: string;
            task_definition_criteria: { text: string; display_order: number }[];
          };
        };
        setTasks(
          (data as unknown as Row[]).map((r) => ({
            instance_id: r.id,
            title: r.task_definition_revisions.title,
            state: r.state,
            satisfaction: r.state,
            correction_note: r.correction_note,
            criteria: [...r.task_definition_revisions.task_definition_criteria]
              .sort((a, b) => a.display_order - b.display_order)
              .map((c) => c.text),
          })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    void load();

    const channel = supabase
      .channel(`room:${spaceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_instances" },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [spaceId]);

  if (!spaceId) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p className="text-muted">No room chosen.</p>
        <Link href="/" className="mt-3 inline-block font-semibold text-accent">
          Back to the house
        </Link>
      </main>
    );
  }

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

      {error && (
        <p role="alert" className="mt-4 rounded-[var(--radius-card)] border border-attention-line bg-attention-wash px-4 py-3 text-attention-ink">
          {error}
        </p>
      )}

      {status && (
        <>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
            {status.name}
          </h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            {LABEL[status.status]}
            {status.note ? ` · ${status.note}` : ""}
          </p>
        </>
      )}

      <ul className="mt-6 flex flex-col gap-3">
        {tasks.map((t) => (
          <li
            key={t.instance_id}
            className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
          >
            <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
              {t.title}
            </p>
            {t.correction_note && (
              <p className="mt-2 rounded-xl border border-attention-line bg-attention-wash px-3 py-2 text-sm text-attention-ink">
                Sent back: {t.correction_note}
              </p>
            )}
            {/* The criteria, not just the title. "Tidy your room" is the thing
                the brief says this app must never be. */}
            <ul className="mt-3 flex flex-col gap-1.5">
              {t.criteria.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm text-ink">
                  <span aria-hidden="true" className="text-muted">
                    ·
                  </span>
                  {c}
                </li>
              ))}
            </ul>
          </li>
        ))}
        {tasks.length === 0 && !error && (
          <li className="text-muted">Nothing needed here today.</li>
        )}
      </ul>
    </main>
  );
}
