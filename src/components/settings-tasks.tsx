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
  title: string;
  recurrence: "daily" | "school_day" | "one_off";
  criteria: string[];
  assigned: string[];
}

interface Member {
  id: string;
  display_name: string;
  role: "parent" | "child";
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
        `id, is_active, location_space_id, occurrence_mode,
         task_definition_revisions!task_definitions_current_revision_fk (
           title, recurrence,
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
      task_definition_revisions: {
        title: string;
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
          title: r.task_definition_revisions!.title,
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
                  p_subject_member_ids:
                    values.occurrenceMode === "per_member" ? values.assigned : [],
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
                  {t.occurrence_mode === "shared" ? "Anyone" : "Each child"}
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

interface FormValues {
  title: string;
  criteria: string[];
  spaceId: string | null;
  occurrenceMode: "shared" | "per_member";
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

  const filled = criteria.map((c) => c.trim()).filter(Boolean);
  const valid = title.trim().length > 0 && filled.length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSave({
          title: title.trim(),
          criteria: filled,
          spaceId: spaceId || null,
          occurrenceMode,
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

      {occurrenceMode === "per_member" && (
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
