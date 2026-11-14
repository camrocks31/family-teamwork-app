"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase/client";
import { evaluateSpaceStatus, type SpaceResult, type SpaceStatus } from "@/lib/readiness";
import { TaskConflictError, tasks as taskApi } from "@/lib/tasks";

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
  /** Carried so a transition can refuse a stale write rather than clobber it. */
  version: number;
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
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * Do the thing, then let realtime bring the truth back.
   *
   * No optimistic update: the database decides whether a transition is legal,
   * and the one failure worth designing for is two people tapping the same
   * task at once. The version goes with the request so the loser is told
   * plainly rather than quietly overwriting the winner.
   */
  async function act(task: RoomTask, run: () => Promise<unknown>) {
    setBusyId(task.instance_id);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(
        e instanceof TaskConflictError
          ? "Somebody else just changed this one. It has been refreshed."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    if (!spaceId) return;
    const supabase = getSupabaseClient();

    const load = async () => {
      try {
/*
         * The foreign keys are named explicitly, and they have to be.
         *
         * task_instances reaches task_definitions by THREE constraints — the plain
         * one plus the composite pairs that keep the denormalised household_id and
         * occurrence_mode honest — so PostgREST refuses to guess and answers
         * PGRST201. The page then caught the error, rendered no tasks, and looked
         * like a room with nothing to do in it. The room view shipped that way and
         * its test passed, because "a list item is visible" is also true of the
         * empty state.
         */
        setStatus(await evaluateSpaceStatus(spaceId));

        const { data, error: taskError } = await supabase
          .from("task_instances")
          .select(
            `id, state, version, correction_note,
             task_definitions!task_instances_definition_id_fkey!inner ( location_space_id ),
             task_definition_revisions!task_instances_definition_revision_id_fkey!inner (
               title,
               task_definition_criteria!task_definition_criteria_revision_id_fkey ( text, display_order )
             )`,
          )
          .eq("task_definitions.location_space_id", spaceId)
          .order("id");
        if (taskError) throw new Error(taskError.message);

        type Row = {
          id: string;
          state: string;
          version: number;
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
            version: r.version,
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

            <TaskActions
              task={t}
              busy={busyId === t.instance_id}
              onAct={(run) => void act(t, run)}
            />
          </li>
        ))}
        {tasks.length === 0 && !error && (
          <li className="text-muted">Nothing needed here today.</li>
        )}
      </ul>
    </main>
  );
}

/**
 * What you can do to this task, right now.
 *
 * Only the moves the task's current state actually allows are offered — the
 * database refuses the rest anyway, and a button that exists to produce an
 * error is a worse answer than no button. The version travels with every
 * request so a second person tapping the same task is told, not ignored.
 */
function TaskActions({
  task,
  busy,
  onAct,
}: {
  task: RoomTask;
  busy: boolean;
  onAct: (run: () => Promise<unknown>) => void;
}) {
  const primary = "min-h-[48px] flex-1 rounded-2xl bg-accent px-4 font-[family-name:var(--font-display)] text-base font-semibold text-white disabled:opacity-60";
  const secondary = "min-h-[48px] rounded-2xl border border-line bg-ground px-4 text-base font-semibold text-ink disabled:opacity-60";

  if (task.state === "not_applicable") {
    return <p className="mt-4 text-sm font-semibold text-muted">Not needed today.</p>;
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {(task.state === "pending" ||
        task.state === "in_progress" ||
        task.state === "needs_attention") && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(() => taskApi.complete(task.instance_id, task.version))}
          className={primary}
        >
          {busy ? "Saving…" : "Mark done"}
        </button>
      )}

      {task.state === "submitted" && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(() => taskApi.approve(task.instance_id, task.version))}
            className={primary}
          >
            {busy ? "Saving…" : "Looks good"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAct(() =>
                taskApi.returnForCorrection(
                  task.instance_id,
                  "Please have another go.",
                  task.version,
                ),
              )
            }
            className={secondary}
          >
            Send back
          </button>
        </>
      )}

      {task.state === "completed" && (
        <>
          <p className="flex min-h-[48px] flex-1 items-center font-semibold text-[color:var(--color-done)]">
            Done
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAct(() =>
                taskApi.returnForCorrection(
                  task.instance_id,
                  "Please have another go.",
                  task.version,
                ),
              )
            }
            className={secondary}
          >
            Send back
          </button>
        </>
      )}

      {task.state !== "completed" && task.state !== "submitted" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(() => taskApi.markNotNeeded(task.instance_id, task.version))}
          className={secondary}
        >
          Not needed
        </button>
      )}
    </div>
  );
}
