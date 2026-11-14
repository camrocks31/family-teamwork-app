"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";

/**
 * Rewards — a named thing a child earns by completing N jobs over a day or a
 * week.
 *
 * Progress is never stored, only counted from the jobs actually recorded, so
 * a parent sending work back takes the progress with it. That is why there is
 * nothing here to "recalculate" and no way for the number on a child's screen
 * to disagree with what they have done.
 */

interface Reward {
  id: string;
  name: string;
  icon: string | null;
  threshold_count: number;
  period: "day" | "week";
  member_id: string | null;
  is_active: boolean;
}

interface Member {
  id: string;
  display_name: string;
  role: "parent" | "child";
}

export function SettingsRewards({
  householdId,
  members,
  onError,
  onNote,
}: {
  householdId: string;
  members: Member[];
  onError: (message: string | null) => void;
  onNote: (message: string) => void;
}) {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await getSupabaseClient()
      .from("rewards")
      .select("id, name, icon, threshold_count, period, member_id, is_active")
      .order("name");
    if (error) throw new Error(error.message);
    setRewards((data as Reward[]) ?? []);
  }, []);

  useEffect(() => {
    // Fetching on mount, which is what an effect is for.
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
      setAdding(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const children = members.filter((m) => m.role === "child");
  const nameOf = new Map(children.map((c) => [c.id, c.display_name]));

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          Rewards
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto min-h-[44px] rounded-xl bg-accent px-4 text-sm font-semibold text-white"
          >
            Add a reward
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Earned by finishing a number of jobs. If a job is sent back, the
        progress goes back down with it.
      </p>

      {adding && (
        <RewardForm
          children2={children}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={(v) =>
            run(`${v.name} added.`, async () => {
              const { error } = await getSupabaseClient().from("rewards").insert({
                household_id: householdId,
                name: v.name,
                icon: v.icon || null,
                threshold_count: v.threshold,
                period: v.period,
                member_id: v.memberId,
              });
              if (error) throw new Error(error.message);
            })
          }
        />
      )}

      <ul className="mt-4 flex flex-col gap-2">
        {rewards.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4"
          >
            <div className="min-w-0 flex-1">
              <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                {r.icon && <span aria-hidden="true">{r.icon} </span>}
                {r.name}
                {!r.is_active && (
                  <span className="ml-2 text-sm font-normal text-muted">off</span>
                )}
              </p>
              <p className="text-sm text-muted">
                {r.threshold_count} {r.threshold_count === 1 ? "job" : "jobs"}
                {r.period === "day" ? " in a day" : " in a week"}
                {" · "}
                {r.member_id ? (nameOf.get(r.member_id) ?? "one child") : "every child"}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(r.is_active ? `${r.name} turned off.` : `${r.name} is back on.`, async () => {
                  const { error } = await getSupabaseClient()
                    .from("rewards")
                    .update({ is_active: !r.is_active })
                    .eq("id", r.id);
                  if (error) throw new Error(error.message);
                })
              }
              className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold disabled:opacity-60"
            >
              {r.is_active ? "Turn off" : "Turn on"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(`${r.name} deleted.`, async () => {
                  const { error } = await getSupabaseClient()
                    .from("rewards")
                    .delete()
                    .eq("id", r.id);
                  if (error) throw new Error(error.message);
                })
              }
              className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold disabled:opacity-60"
            >
              Delete
            </button>
          </li>
        ))}
        {rewards.length === 0 && !adding && (
          <li className="text-muted">No rewards yet.</li>
        )}
      </ul>
    </section>
  );
}

function RewardForm({
  children2,
  busy,
  onSave,
  onCancel,
}: {
  children2: Member[];
  busy: boolean;
  onSave: (v: {
    name: string;
    icon: string;
    threshold: number;
    period: "day" | "week";
    memberId: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [threshold, setThreshold] = useState(10);
  const [period, setPeriod] = useState<"day" | "week">("week");
  const [memberId, setMemberId] = useState<string>("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && threshold > 0) {
          onSave({
            name: name.trim(),
            icon: icon.trim(),
            threshold,
            period,
            memberId: memberId || null,
          });
        }
      }}
      className="mt-4 flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5"
    >
      <div className="flex flex-wrap gap-4">
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <label htmlFor="reward-name" className="text-sm font-semibold">
            What is the reward?
          </label>
          <input
            id="reward-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Film night"
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reward-icon" className="text-sm font-semibold">
            Icon
          </label>
          <input
            id="reward-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            maxLength={4}
            placeholder="🍿"
            className="min-h-[48px] w-20 rounded-xl border border-line bg-ground px-3 text-center"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reward-threshold" className="text-sm font-semibold">
            How many jobs?
          </label>
          <input
            id="reward-threshold"
            type="number"
            min={1}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="min-h-[48px] w-28 rounded-xl border border-line bg-ground px-3"
          />
        </div>
        <div className="flex min-w-[160px] flex-col gap-1.5">
          <label htmlFor="reward-period" className="text-sm font-semibold">
            Over what?
          </label>
          <select
            id="reward-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as "day" | "week")}
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
          >
            <option value="week">A week</option>
            <option value="day">A day</option>
          </select>
        </div>
        <div className="flex min-w-[180px] flex-1 flex-col gap-1.5">
          <label htmlFor="reward-who" className="text-sm font-semibold">
            Who can earn it?
          </label>
          <select
            id="reward-who"
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            className="min-h-[48px] rounded-xl border border-line bg-ground px-3"
          >
            <option value="">Every child</option>
            {children2.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy || !name.trim() || threshold < 1}
          className="min-h-[52px] flex-1 rounded-2xl bg-accent font-[family-name:var(--font-display)] text-lg font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save reward"}
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
