"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/auth-gate";
import { getSupabaseClient } from "@/lib/supabase/client";
import { getActor, type Actor } from "@/lib/kiosk";
import { TaskConflictError, tasks as taskApi } from "@/lib/tasks";

/**
 * My jobs — what this child has to do today, and a button to say it is done.
 *
 * The brief's test for this page is a seven-year-old using it alone, so there
 * is one list, one button per job, and the criteria are on screen rather than
 * hidden behind a title like "tidy your room".
 *
 * Attribution comes from the actor token, which the transition helpers attach
 * on their own. Tapping "Done" here is recorded as Desmond's work even though
 * the browser session belongs to a parent — that separation is the whole
 * reason the kiosk identity exists.
 */

interface MyTask {
  instance_id: string;
  title: string;
  state: string;
  version: number;
  criteria: string[];
  where: string | null;
  correction_note: string | null;
}

export default function MyJobsPage() {
  return (
    <AuthGate>
      <MyJobs />
    </AuthGate>
  );
}

function MyJobs() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [myTasks, setMyTasks] = useState<MyTask[]>([]);
  const [shared, setShared] = useState<MyTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (memberId: string) => {
    const supabase = getSupabaseClient();
    const { data, error: loadError } = await supabase
      .from("task_instances")
      // Every foreign key is named: task_instances reaches task_definitions
      // by three constraints and task_definition_revisions by two, so an
      // unqualified embed is ambiguous and PostgREST answers PGRST201.
      .select(
        `id, state, version, correction_note, subject_member_id, occurrence_mode,
         task_definitions!task_instances_definition_id_fkey!inner (
           household_spaces!task_definitions_location_space_id_fkey ( name )
         ),
         task_definition_revisions!task_instances_definition_revision_id_fkey!inner (
           title,
           task_definition_criteria!task_definition_criteria_revision_id_fkey ( text, display_order )
         )`,
      )
      .order("id");
    if (loadError) throw new Error(loadError.message);

    type Row = {
      id: string;
      state: string;
      version: number;
      correction_note: string | null;
      subject_member_id: string | null;
      occurrence_mode: string;
      task_definitions: { household_spaces: { name: string } | null } | null;
      task_definition_revisions: {
        title: string;
        task_definition_criteria: { text: string; display_order: number }[];
      };
    };

    const shape = (r: Row): MyTask => ({
      instance_id: r.id,
      title: r.task_definition_revisions.title,
      state: r.state,
      version: r.version,
      where: r.task_definitions?.household_spaces?.name ?? null,
      correction_note: r.correction_note,
      criteria: [...r.task_definition_revisions.task_definition_criteria]
        .sort((a, b) => a.display_order - b.display_order)
        .map((c) => c.text),
    });

    const rows = (data as unknown as Row[]) ?? [];
    // Mine means mine. A shared job belongs to the house, and the difference
    // matters to a child who has already done their own.
    setMyTasks(rows.filter((r) => r.subject_member_id === memberId).map(shape));
    setShared(rows.filter((r) => r.subject_member_id === null).map(shape));
  }, []);

  useEffect(() => {
    // Deliberate, for the same reason as the picker: who is at the iPad
    // lives in localStorage, which a statically prerendered page cannot know
    // until it has mounted in a browser.
    const current = getActor();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActor(current);
    if (!current) {
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();
    const refresh = () =>
      load(current.memberId)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    void refresh();

    const channel = supabase
      .channel("my-jobs")
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

  async function markDone(task: MyTask) {
    setBusyId(task.instance_id);
    setError(null);
    try {
      await taskApi.complete(task.instance_id, task.version);
    } catch (e) {
      setError(
        e instanceof TaskConflictError
          ? "Somebody else just changed this one."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusyId(null);
    }
  }

  if (!actor) {
    return (
      <main className="mx-auto w-full max-w-2xl px-5 py-6">
        <BackLink />
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold">
          Who are you?
        </h1>
        <p className="mt-2 text-muted">
          Tap your name on the home screen first, then come back here.
        </p>
      </main>
    );
  }

  const outstanding = (t: MyTask) => t.state !== "completed" && t.state !== "not_applicable";
  const mineLeft = myTasks.filter(outstanding);
  const sharedLeft = shared.filter(outstanding);

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-6">
      <BackLink />

      <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
        {actor.displayName}&rsquo;s jobs
      </h1>
      <p className="mt-1 text-muted">
        {loading
          ? "Looking…"
          : mineLeft.length === 0
            ? "Nothing of your own left. Nice one."
            : `${mineLeft.length} to go`}
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-[var(--radius-card)] border border-attention-line bg-attention-wash px-4 py-3 text-attention-ink"
        >
          {error}
        </p>
      )}

      <TaskList
        heading="Just yours"
        tasks={myTasks}
        busyId={busyId}
        onDone={markDone}
        empty="Nothing of your own today."
      />

      <TaskList
        heading="Anyone can do these"
        tasks={shared}
        busyId={busyId}
        onDone={markDone}
        empty="Nothing shared left today."
        count={sharedLeft.length}
      />
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/"
      className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-accent"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
      The house
    </Link>
  );
}

function TaskList({
  heading,
  tasks,
  busyId,
  onDone,
  empty,
  count,
}: {
  heading: string;
  tasks: MyTask[];
  busyId: string | null;
  onDone: (task: MyTask) => void;
  empty: string;
  count?: number;
}) {
  const left = tasks.filter((t) => t.state !== "completed" && t.state !== "not_applicable");
  return (
    <section className="mt-8">
      <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
        {heading}
        {count !== undefined && left.length > 0 && (
          <span className="ml-2 text-base font-normal text-muted">{left.length} left</span>
        )}
      </h2>

      {left.length === 0 ? (
        <p className="mt-3 text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {left.map((t) => (
            <li
              key={t.instance_id}
              className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
            >
              <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                {t.title}
              </p>
              {t.where && <p className="text-sm text-muted">{t.where}</p>}

              {t.correction_note && (
                <p className="mt-2 rounded-xl border border-attention-line bg-attention-wash px-3 py-2 text-sm text-attention-ink">
                  Sent back: {t.correction_note}
                </p>
              )}

              {t.criteria.length > 0 && (
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

              <button
                type="button"
                disabled={busyId === t.instance_id}
                onClick={() => onDone(t)}
                className="mt-4 min-h-[52px] w-full rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white disabled:opacity-60"
              >
                {busyId === t.instance_id ? "Saving…" : "Done"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
