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

interface RewardProgress {
  id: string;
  name: string;
  icon: string | null;
  period: "day" | "week";
  threshold_count: number;
  done: number;
  earned: boolean;
  still_needed: number;
}

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
  const [rewards, setRewards] = useState<RewardProgress[]>([]);
  // Young or early readers get one job at a time instead of a list. A
  // list of four is a task list to an eleven-year-old and a wall to a
  // seven-year-old; the flag is set by a parent, not guessed from age.
  const [simple, setSimple] = useState(false);

  const load = useCallback(async (memberId: string) => {
    const supabase = getSupabaseClient();

    // list_my_jobs, not a query over task_instances.
    //
    // An instance exists for every active job every day, because
    // applicability is decided at call time and never written down — that is
    // what lets a snow day declared at 07:30 take effect at 07:30. The cost
    // is that listing instances directly shows jobs that do not apply, and
    // this page did exactly that: on a Saturday it told Hazel to pack a
    // school lunch. There is one implementation of "does this apply", in the
    // database, and this is how a client reaches it.
    const { data, error: loadError } = await supabase.rpc("list_my_jobs", {
      p_member_id: memberId,
    });
    if (loadError) throw new Error(loadError.message);

    type Row = {
      instance_id: string;
      title: string;
      state: string;
      version: number;
      correction_note: string | null;
      mine: boolean;
      where: string | null;
      criteria: string[];
    };

    const payload = (data ?? { jobs: [], simple_view: false }) as {
      simple_view: boolean;
      jobs: Row[];
    };
    setSimple(Boolean(payload.simple_view));
    const rows = payload.jobs ?? [];
    const shape = (r: Row): MyTask => ({
      instance_id: r.instance_id,
      title: r.title,
      state: r.state,
      version: r.version,
      where: r.where,
      correction_note: r.correction_note,
      criteria: r.criteria,
    });

    // Reward progress, counted from the work actually recorded. Fetched
    // alongside the jobs so finishing one and watching the number move is a
    // single refresh, not two.
    const { data: household } = await supabase.from("households").select("id").maybeSingle();
    if (household) {
      const { data: progress, error: rewardError } = await supabase.rpc("evaluate_rewards", {
        p_household_id: household.id,
        p_member_id: memberId,
      });
      if (rewardError) throw new Error(rewardError.message);
      setRewards((progress as RewardProgress[]) ?? []);
    }

    setMyTasks(rows.filter((r) => r.mine).map(shape));
    setShared(rows.filter((r) => !r.mine).map(shape));
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

      {rewards.length > 0 && (
        <section className="mt-8">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
            What you&rsquo;re working towards
          </h2>
          <ul className="mt-3 flex flex-col gap-3">
            {rewards.map((r) => (
              <li
                key={r.id}
                className={`rounded-[var(--radius-card)] border p-4 ${
                  r.earned
                    ? "border-[color:var(--color-done)]/30 bg-done-wash"
                    : "border-line bg-surface"
                }`}
              >
                <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                  {r.icon && <span aria-hidden="true">{r.icon} </span>}
                  {r.name}
                </p>
                <p className="text-sm text-muted">
                  {r.earned
                    ? "Earned!"
                    : `${r.done} of ${r.threshold_count} ${
                        r.period === "day" ? "today" : "this week"
                      } — ${r.still_needed} to go`}
                </p>
                <div
                  role="progressbar"
                  aria-valuenow={r.done}
                  aria-valuemin={0}
                  aria-valuemax={r.threshold_count}
                  aria-label={`${r.name} progress`}
                  className="mt-2 h-3 w-full overflow-hidden rounded-full bg-ground"
                >
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{
                      width: `${Math.min(100, (r.done / r.threshold_count) * 100)}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {simple ? (
        <SimpleView
          mine={myTasks}
          shared={shared}
          busyId={busyId}
          onDone={markDone}
        />
      ) : (
        <>
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
        </>
      )}
    </main>
  );
}

/**
 * One job, as big as the screen allows.
 *
 * Their own work comes first, then the house's. No counts, no sections, no
 * scrolling: a child who can see only the next thing cannot be overwhelmed
 * by the list behind it, and finishing it reveals the next one.
 */
function SimpleView({
  mine,
  shared,
  busyId,
  onDone,
}: {
  mine: MyTask[];
  shared: MyTask[];
  busyId: string | null;
  onDone: (task: MyTask) => void;
}) {
  const outstanding = (t: MyTask) => t.state !== "completed" && t.state !== "not_applicable";
  const queue = [...mine.filter(outstanding), ...shared.filter(outstanding)];
  const next = queue[0];

  if (!next) {
    return (
      <section className="mt-10 rounded-[var(--radius-card)] border border-[color:var(--color-done)]/30 bg-done-wash p-8 text-center">
        <p className="font-[family-name:var(--font-display)] text-3xl font-bold text-[color:var(--color-done)]">
          All done!
        </p>
        <p className="mt-2 text-muted">Nothing left for you today.</p>
      </section>
    );
  }

  return (
    <section className="mt-8 flex flex-col gap-4">
      <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-muted">
        {queue.length === 1 ? "One more thing" : `Next of ${queue.length}`}
      </p>

      <div className="rounded-[var(--radius-card)] border border-attention-line bg-attention-wash p-6">
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold">
          {next.title}
        </h2>
        {next.where && <p className="mt-1 text-muted">{next.where}</p>}

        {next.correction_note && (
          <p className="mt-3 rounded-xl border border-attention-line bg-surface px-3 py-2 text-sm text-attention-ink">
            Have another go: {next.correction_note}
          </p>
        )}

        {next.criteria.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {next.criteria.map((c, i) => (
              <li key={i} className="flex gap-2.5 text-base">
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
          disabled={busyId === next.instance_id}
          onClick={() => onDone(next)}
          className="mt-6 min-h-[64px] w-full rounded-2xl bg-accent font-[family-name:var(--font-display)] text-xl font-bold text-white disabled:opacity-60"
        >
          {busyId === next.instance_id ? "Saving…" : "I did it"}
        </button>
      </div>
    </section>
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
