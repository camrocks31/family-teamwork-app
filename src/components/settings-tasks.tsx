"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Space } from "@/components/settings-rooms";

/**
 * Tasks, editable — including the criteria, which are the point.
 *
 * The brief forbids an opaque "clean the house" checkbox, so a task here is
 * a title plus the specific things that count as done, and save_task refuses
 * one with no criteria at all.
 *
 * Saving an edit writes a NEW revision rather than changing the old one, so
 * history is never rewritten: a task renamed this afternoon leaves this
 * morning's instance saying what it said this morning. That is why this goes
 * through save_task instead of three separate writes from the browser.
 */

interface TaskRow {
  id: string;
  is_active: boolean;
  location_space_id: string | null;
  occurrence_mode: "shared" | "per_member";
  assignment_mode: "assigned" | "open";
  title: string;
  reason: string | null;
  counts_toward_rewards: boolean;
  recurrence: "daily" | "school_day" | "one_off";
  criteria: string[];
  assigned: string[];
}

interface Member {
  id: string;
  display_name: string;
  role: "parent" | "child";
  min_chosen_jobs?: number;
}

const RECURRENCE_LABEL: Record<TaskRow["recurrence"], string> = {
  daily: "Every day",
  school_day: "School mornings",
  one_off: "Once",
};

export function SettingsTasks({
  spaces,
  members,
  onError,
  onNote,
}: {
  spaces: Space[];
  members: Member[];
  onError: (message: string | null) => void;
  onNote: (message: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [editing, setEditing] = useState<TaskRow | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseClient();
    // Every embed names its foreign key: task_definitions reaches
    // task_definition_revisions by two constraints, so an unqualified one is
    // ambiguous and PostgREST answers PGRST201.
    const { data, error } = await supabase
      .from("task_definitions")
      .select(
        `id, is_active, location_space_id, occurrence_mode, assignment_mode,
         task_definition_revisions!task_definitions_current_revision_fk (
           title, recurrence, reason, counts_toward_rewards,
           task_definition_criteria!task_definition_criteria_revision_id_fkey ( text, display_order )
         ),
         task_assignments!task_assignments_definition_id_fkey ( member_id )`,
      )
      .order("id");
    if (error) throw new Error(error.message);

    type Row = {
      id: string;
      is_active: boolean;
      location_space_id: string | null;
      occurrence_mode: "shared" | "per_member";
      assignment_mode: "assigned" | "open";
      task_definition_revisions: {
        title: string;
        reason: string | null;
        counts_toward_rewards: boolean;
        recurrence: TaskRow["recurrence"];
        task_definition_criteria: { text: string; display_order: number }[];
      } | null;
      task_assignments: { member_id: string }[];
    };

    setTasks(
      ((data as unknown as Row[]) ?? [])
        .filter((r) => r.task_definition_revisions)
        .map((r) => ({
          id: r.id,
          is_active: r.is_active,
          location_space_id: r.location_space_id,
          occurrence_mode: r.occurrence_mode,
          assignment_mode: r.assignment_mode,
          title: r.task_definition_revisions!.title,
          reason: r.task_definition_revisions!.reason,
          counts_toward_rewards: r.task_definition_revisions!.counts_toward_rewards,
          recurrence: r.task_definition_revisions!.recurrence,
          criteria: [...r.task_definition_revisions!.task_definition_criteria]
            .sort((a, b) => a.display_order - b.display_order)
            .map((c) => c.text),
          assigned: r.task_assignments.map((a) => a.member_id),
        })),
    );
  }, []);

  useEffect(() => {
    // Fetching on mount, which is what an effect is for. The rule traces
    // into load() and sees the setState there; there is no earlier moment
    // to know this data, and the alternative is hiding the same call
    // inside an IIFE to defeat the check rather than satisfy it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function run(note: string, fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await load();
      onNote(note);
      setEditing(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const nameOfSpace = new Map(spaces.map((s) => [s.id, s.name]));
  const children = members.filter((m) => m.role === "child");

  if (editing) {
    return (
      <section className="mt-10">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          {editing === "new" ? "New job" : "Edit job"}
        </h2>
        <TaskForm
          task={editing === "new" ? null : editing}
          spaces={spaces.filter((s) => s.parent_space_id !== null && s.is_active)}
          kids={children}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(values) =>
            run(
              editing === "new" ? `${values.title} added.` : `${values.title} saved.`,
              async () => {
                const { error } = await getSupabaseClient().rpc("save_task", {
                  p_definition_id: editing === "new" ? null : editing.id,
                  p_title: values.title,
                  p_criteria: values.criteria,
                  p_space_id: values.spaceId,
                  p_occurrence_mode: values.occurrenceMode,
                  p_recurrence: values.recurrence,
                  // Null for an open job, so the children's own choices are
                  // never in the payload at all. save_task ignores it for an
                  // open definition anyway, but a form that cannot send the
                  // wrong thing is better than one that relies on being
                  // ignored.
                  p_subject_member_ids:
                    values.assignmentMode === "open"
                      ? null
                      : values.occurrenceMode === "per_member"
                        ? values.assigned
                        : [],
                  p_reason: values.reason || null,
                  p_assignment_mode: values.assignmentMode,
                  p_counts_toward_rewards: values.countsTowardRewards,
                });
                if (error) throw new Error(error.message);
              },
            )
          }
        />
      </section>
    );
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          Jobs
        </h2>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="ml-auto min-h-[44px] rounded-xl bg-accent px-4 text-sm font-semibold text-white"
        >
          Add a job
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        Editing a job keeps the old wording on days already recorded.
      </p>

      <HowManyPicked members={members} onError={onError} onNote={onNote} />

      <ul className="mt-4 flex flex-col gap-3">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="rounded-[var(--radius-card)] border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                  {t.title}
                  {!t.is_active && (
                    <span className="ml-2 text-sm font-normal text-muted">stopped</span>
                  )}
                </p>
                <p className="text-sm text-muted">
                  {t.location_space_id
                    ? (nameOfSpace.get(t.location_space_id) ?? "A room")
                    : "No room"}
                  {" · "}
                  {RECURRENCE_LABEL[t.recurrence]}
                  {" · "}
                  {t.assignment_mode === "open"
                    ? "Anyone can take it"
                    : t.occurrence_mode === "shared"
                      ? "Anyone"
                      : "Each child"}
                  {" · "}
                  {t.counts_toward_rewards ? "Counts for rewards" : "No points"}
                  {" · "}
                  {t.criteria.length}{" "}
                  {t.criteria.length === 1 ? "thing to check" : "things to check"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditing(t)}
                className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(t.is_active ? `${t.title} stopped.` : `${t.title} is back.`, async () => {
                    const { error } = await getSupabaseClient().rpc("set_task_active", {
                      p_definition_id: t.id,
                      p_active: !t.is_active,
                    });
                    if (error) throw new Error(error.message);
                  })
                }
                className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold disabled:opacity-60"
              >
                {t.is_active ? "Stop" : "Start again"}
              </button>
            </div>
          </li>
        ))}
        {tasks.length === 0 && <li className="text-muted">No jobs yet.</li>}
      </ul>
    </section>
  );
}

/**
 * How many of the spare jobs each person is ASKED to pick.
 *
 * Asked, not made to. The number is shown on the child's own page as a
 * shortfall and nothing is blocked if they hold fewer — a minimum the app
 * enforced would be an assignment wearing a choice's clothes, and would also
 * trap a child who wants to swap one job for another.
 *
 * Zero means nothing is asked of that person, which is the default and is a
 * perfectly good answer for the youngest.
 */
function HowManyPicked({
  members,
  onError,
  onNote,
}: {
  members: Member[];
  onError: (message: string | null) => void;
  onNote: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const children = members.filter((m) => m.role === "child");
  if (children.length === 0) return null;

  async function save(member: Member, value: number) {
    setBusy(true);
    onError(null);
    try {
      const { error } = await getSupabaseClient()
        .from("family_members")
        .update({ min_chosen_jobs: value })
        .eq("id", member.id);
      if (error) throw new Error(error.message);
      onNote(
        value === 0
          ? `Nothing is asked of ${member.display_name}.`
          : `${member.display_name} is asked to pick ${value}.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-[var(--radius-card)] border border-line bg-surface p-4">
      <p className="text-sm font-semibold">How many spare jobs each person picks</p>
      <p className="mt-0.5 text-sm text-muted">
        Shown on their own page as a gap, never enforced. Zero asks nothing.
      </p>
      <ul className="mt-3 flex flex-wrap gap-4">
        {children.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <label htmlFor={`min-${c.id}`} className="text-sm font-medium">
              {c.display_name}
            </label>
            <input
              id={`min-${c.id}`}
              type="number"
              min={0}
              max={20}
              disabled={busy}
              defaultValue={c.min_chosen_jobs ?? 0}
              onBlur={(e) => {
                const next = Math.max(0, Number(e.target.value) || 0);
                if (next !== (c.min_chosen_jobs ?? 0)) void save(c, next);
              }}
              className="min-h-[44px] w-20 rounded-xl border border-line bg-ground px-3 text-base"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FormValues {
  title: string;
  reason: string;
  criteria: string[];
  spaceId: string | null;
  occurrenceMode: "shared" | "per_member";
  assignmentMode: "assigned" | "open";
  countsTowardRewards: boolean;
  recurrence: TaskRow["recurrence"];
  assigned: string[];
}

function TaskForm({
  task,
  spaces,
  kids,
  busy,
  onSave,
  onCancel,
}: {
  task: TaskRow | null;
  spaces: Space[];
  kids: Member[];
  busy: boolean;
  onSave: (values: FormValues) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [criteria, setCriteria] = useState<string[]>(
    task?.criteria.length ? task.criteria : [""],
  );
  const [spaceId, setSpaceId] = useState<string>(task?.location_space_id ?? "");
  const [occurrenceMode, setOccurrenceMode] = useState<"shared" | "per_member">(
    task?.occurrence_mode ?? "shared",
  );
  const [recurrence, setRecurrence] = useState<TaskRow["recurrence"]>(
    task?.recurrence ?? "daily",
  );
  const [assigned, setAssigned] = useState<string[]>(task?.assigned ?? []);
  const [reason, setReason] = useState(task?.reason ?? "");
  const [assignmentMode, setAssignmentMode] = useState<"assigned" | "open">(
    task?.assignment_mode ?? "assigned",
  );
  const [countsTowardRewards, setCountsTowardRewards] = useState(
    task?.counts_toward_rewards ?? true,
  );

  const filled = criteria.map((c) => c.trim()).filter(Boolean);
  const valid = title.trim().length > 0 && filled.length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSave({
          title: title.trim(),
          reason: reason.trim(),
          criteria: filled,
          spaceId: spaceId || null,
          // An open job has to be per-member: a shared job has no subject to
          // hold it, and the database refuses the combination outright.
          occurrenceMode: assignmentMode === "open" ? "per_member" : occurrenceMode,
          assignmentMode,
          countsTowardRewards,
          recurrence,
          assigned,
        });
      }}
      className="mt-4 flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="task-title" className="text-sm font-semibold">
          What is the job called?
        </label>
        <input
          id="task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="task-reason" className="text-sm font-semibold">
          Why this matters
        </label>
        <p className="text-sm text-muted">
          One honest sentence, in your own words. The children read this, so
          &ldquo;because I said so&rdquo; is worse than leaving it blank. It can
          say the job is dull.
        </p>
        <input
          id="task-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="If this room is gross nobody wants to be in here, you included."
          className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">
          What counts as done?
        </legend>
        <p className="text-sm text-muted">
          One line each. This is what a child sees, so &ldquo;tidy your
          room&rdquo; on its own is not enough.
        </p>
        {criteria.map((c, i) => (
          <div key={i} className="flex gap-2">
            <label className="sr-only" htmlFor={`criterion-${i}`}>
              Thing to check {i + 1}
            </label>
            <input
              id={`criterion-${i}`}
              value={c}
              onChange={(e) =>
                setCriteria((list) => list.map((v, j) => (j === i ? e.target.value : v)))
              }
              className="min-h-[48px] flex-1 rounded-xl border border-line bg-ground px-3"
            />
            <button
              type="button"
              aria-label={`Remove thing to check ${i + 1}`}
              onClick={() => setCriteria((list) => list.filter((_, j) => j !== i))}
              className="min-h-[48px] rounded-xl border border-line px-3"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setCriteria((list) => [...list, ""])}
          className="min-h-[44px] self-start rounded-xl border border-line px-3 text-sm font-semibold"
        >
          Add another
        </button>
      </fieldset>

      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
          <label htmlFor="task-room" className="text-sm font-semibold">
            Which room?
          </label>
          <select
            id="task-room"
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
          >
            <option value="">No room</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
          <label htmlFor="task-recurrence" className="text-sm font-semibold">
            How often?
          </label>
          <select
            id="task-recurrence"
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as TaskRow["recurrence"])}
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
          >
            <option value="daily">Every day</option>
            <option value="school_day">School mornings</option>
          </select>
        </div>

        <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
          <label htmlFor="task-mode" className="text-sm font-semibold">
            Who does it?
          </label>
          <select
            id="task-mode"
            value={occurrenceMode}
            onChange={(e) =>
              setOccurrenceMode(e.target.value as "shared" | "per_member")
            }
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
          >
            <option value="shared">Anyone — one job for the house</option>
            <option value="per_member">Each child gets their own</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="task-assignment" className="text-sm font-semibold">
          Given out, or picked up?
        </label>
        <select
          id="task-assignment"
          value={assignmentMode}
          onChange={(e) => setAssignmentMode(e.target.value as "assigned" | "open")}
          className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
        >
          <option value="assigned">I say who does it</option>
          <option value="open">Anyone can take it</option>
        </select>
        {assignmentMode === "open" && (
          <p className="text-sm text-muted">
            It will show up on every child&rsquo;s page as going spare, and
            whoever takes it keeps it until they give it back.
          </p>
        )}
      </div>

      <label className="flex min-h-[44px] items-start gap-3">
        <input
          type="checkbox"
          checked={countsTowardRewards}
          onChange={(e) => setCountsTowardRewards(e.target.checked)}
          className="mt-1 h-5 w-5"
        />
        <span>
          <span className="text-sm font-semibold">This one counts for rewards</span>
          <span className="block text-sm text-muted">
            Leave it off for anything you want them to end up liking — cooking,
            reading, helping each other. Paying for those is how a child learns
            they were only ever worth doing for the points. Bins and bathrooms
            are safe to pay for.
          </span>
        </span>
      </label>

      {assignmentMode === "assigned" && occurrenceMode === "per_member" && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">Which children?</legend>
          <div className="flex flex-wrap gap-3">
            {kids.map((c) => (
              <label key={c.id} className="flex min-h-[44px] items-center gap-2">
                <input
                  type="checkbox"
                  checked={assigned.includes(c.id)}
                  onChange={(e) =>
                    setAssigned((list) =>
                      e.target.checked
                        ? [...list, c.id]
                        : list.filter((id) => id !== c.id),
                    )
                  }
                  className="h-5 w-5"
                />
                {c.display_name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy || !valid}
          className="min-h-[52px] flex-1 rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[52px] rounded-2xl border border-line px-5 font-semibold"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
