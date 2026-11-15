"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { MemberBadge } from "@/components/member-badge";
import type { BadgePerson } from "@/components/member-badge";

/**
 * What each child can do, and what has to be true first.
 *
 * Until this existed every activity was offered to every child, so the
 * dashboard asked the same question of the same people and printed the same
 * answer twice. The brief is explicit that activities are configuration
 * rather than code — "a parent adds Watch YouTube in settings, attaches an
 * existing group, and the engine evaluates it with no source change" — and
 * that promise was only half kept: the rows existed, nothing could edit them.
 *
 * Two controls carry the design.
 *
 *   WHO IT IS FOR. Nobody ticked means everyone, which is what every activity
 *   meant before audiences existed, so the default behaviour is unchanged.
 *
 *   ON YOUR OWN / TOGETHER. A "together" activity waits for every child named
 *   above, not just the one asking. That is deliberately the opposite of a
 *   race: the quickest way to your own evening is to go and help your
 *   brother, because nothing opens until you both finish.
 */

interface Member extends BadgePerson {
  role: "parent" | "child";
}

interface Group {
  id: string;
  name: string;
}

interface Activity {
  id: string;
  name: string;
  icon: string | null;
  participation: "solo" | "team";
  is_active: boolean;
  display_order: number;
  audience: string[];
  groups: string[];
}

interface Draft {
  id: string | null;
  name: string;
  icon: string;
  participation: "solo" | "team";
  audience: string[];
  groups: string[];
}

const ICONS = ["🎮", "🕹️", "📺", "📱", "💻", "⚽️", "🎸", "🚲", "🎨", "🧩"];

const EMPTY: Draft = {
  id: null,
  name: "",
  icon: "🎮",
  participation: "solo",
  audience: [],
  groups: [],
};

export function SettingsActivities({
  members,
  onError,
  onNote,
}: {
  members: Member[];
  onError: (message: string | null) => void;
  onNote: (message: string) => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const children = members.filter((m) => m.role === "child");

  const load = useCallback(async () => {
    const supabase = getSupabaseClient();

    const { data: rows, error } = await supabase
      .from("activities")
      .select("id, name, icon, participation, is_active, display_order")
      .order("display_order")
      .order("name");
    if (error) throw new Error(error.message);

    const { data: audience, error: audienceError } = await supabase
      .from("activity_audience")
      .select("activity_id, member_id");
    if (audienceError) throw new Error(audienceError.message);

    const { data: reqs, error: reqError } = await supabase
      .from("activity_requirements")
      .select("activity_id, group_id");
    if (reqError) throw new Error(reqError.message);

    const { data: groupRows, error: groupError } = await supabase
      .from("requirement_groups")
      .select("id, name")
      .eq("is_active", true)
      .order("name");
    if (groupError) throw new Error(groupError.message);

    setGroups((groupRows as Group[]) ?? []);
    setActivities(
      ((rows as Omit<Activity, "audience" | "groups">[]) ?? []).map((a) => ({
        ...a,
        audience: (audience ?? [])
          .filter((x) => x.activity_id === a.id)
          .map((x) => x.member_id as string),
        groups: (reqs ?? [])
          .filter((x) => x.activity_id === a.id)
          .map((x) => x.group_id as string),
      })),
    );
  }, []);

  useEffect(() => {
    // Fetching on mount, which is what an effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
    // onError is a callback prop; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await load();
      onNote(what);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save(d: Draft) {
    if (!d.name.trim()) {
      onError("An activity needs a name.");
      return;
    }
    // A team of one is refused by the database too; saying so here saves a
    // round trip and explains it where the mistake was made.
    if (d.participation === "team" && d.audience.length < 2) {
      onError("Choose at least two people for something they do together.");
      return;
    }
    await run(`${d.name.trim()} is saved.`, async () => {
      const { error } = await getSupabaseClient().rpc("save_activity", {
        p_activity_id: d.id,
        p_name: d.name.trim(),
        p_icon: d.icon,
        p_participation: d.participation,
        p_requires_parent_approval: false,
        p_member_ids: d.audience,
        p_group_ids: d.groups,
        p_display_order: null,
      });
      if (error) throw new Error(error.message);
    });
    setDraft(null);
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
            What each person can do
          </h2>
          <p className="mt-1 text-sm text-muted">
            Choose who an activity is for, and what has to be done first.
            Nobody ticked means it is for everyone.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => setDraft({ ...EMPTY })}
          className="min-h-[44px] rounded-xl bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          Add an activity
        </button>
      </div>

      {draft && (
        <ActivityForm
          draft={draft}
          people={children}
          groups={groups}
          busy={busy}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => void save(draft)}
        />
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {activities.map((a) => (
          <li
            key={a.id}
            className={`rounded-[var(--radius-card)] border border-line bg-surface p-4 ${
              a.is_active ? "" : "opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span aria-hidden="true" className="text-2xl">
                {a.icon}
              </span>
              <p className="font-[family-name:var(--font-display)] text-lg font-semibold">
                {a.name}
              </p>
              {a.participation === "team" && (
                <span className="rounded-full bg-accent-wash px-2 py-0.5 text-xs font-semibold text-accent">
                  together
                </span>
              )}
              {!a.is_active && (
                <span className="text-xs font-semibold text-muted">turned off</span>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setDraft({
                      id: a.id,
                      name: a.name,
                      icon: a.icon ?? "🎮",
                      participation: a.participation,
                      audience: a.audience,
                      groups: a.groups,
                    })
                  }
                  className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      a.is_active ? `${a.name} is turned off.` : `${a.name} is back on.`,
                      async () => {
                        const { error } = await getSupabaseClient().rpc("set_activity_active", {
                          p_activity_id: a.id,
                          p_active: !a.is_active,
                        });
                        if (error) throw new Error(error.message);
                      },
                    )
                  }
                  className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
                >
                  {a.is_active ? "Turn off" : "Turn on"}
                </button>
              </div>
            </div>

            <p className="mt-2 text-sm text-muted">
              {a.audience.length === 0
                ? "Everyone"
                : children
                    .filter((c) => a.audience.includes(c.id))
                    .map((c) => c.display_name)
                    .join(", ")}
              {" · "}
              {a.groups.length === 0
                ? "nothing required yet"
                : groups
                    .filter((g) => a.groups.includes(g.id))
                    .map((g) => g.name)
                    .join(", ")}
            </p>
          </li>
        ))}
        {activities.length === 0 && (
          <li className="text-muted">Nothing set up yet.</li>
        )}
      </ul>
    </section>
  );
}

function ActivityForm({
  draft,
  people,
  groups,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  /** The household's children. Not React's `children` — that would read as
   *  nested JSX content and silently shadow it. */
  people: Member[];
  groups: Group[];
  busy: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <div className="mt-4 rounded-[var(--radius-card)] border border-accent bg-accent-wash/40 p-4">
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Name</span>
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="PlayStation on your own"
            className="min-h-[48px] rounded-xl border border-line bg-surface px-3 text-base"
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Picture</span>
          <div className="flex flex-wrap gap-2">
            {ICONS.map((icon) => (
              <button
                key={icon}
                type="button"
                aria-label={`Use ${icon}`}
                aria-pressed={draft.icon === icon}
                onClick={() => onChange({ ...draft, icon })}
                className={`flex h-11 w-11 items-center justify-center rounded-xl border text-xl ${
                  draft.icon === icon ? "border-accent bg-surface" : "border-line"
                }`}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Who is it for?</span>
          <p className="text-xs text-muted">
            Leave them all unticked and it is for everyone.
          </p>
          <div className="flex flex-wrap gap-2">
            {people.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={draft.audience.includes(c.id)}
                onClick={() => onChange({ ...draft, audience: toggle(draft.audience, c.id) })}
                className={`flex min-h-[48px] items-center gap-2 rounded-xl border px-3 text-sm font-semibold ${
                  draft.audience.includes(c.id)
                    ? "border-accent bg-surface"
                    : "border-line bg-surface/50"
                }`}
              >
                <MemberBadge person={c} size="sm" />
                {c.display_name}
              </button>
            ))}
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold">On their own, or together?</legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["solo", "On their own", "Their own work unlocks it."],
                [
                  "team",
                  "Together",
                  "Waits for everyone named above — so helping each other is the quickest way in.",
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                aria-pressed={draft.participation === value}
                onClick={() => onChange({ ...draft, participation: value })}
                className={`flex min-h-[48px] max-w-xs flex-col items-start justify-center rounded-xl border px-3 py-2 text-left ${
                  draft.participation === value
                    ? "border-accent bg-surface"
                    : "border-line bg-surface/50"
                }`}
              >
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-xs text-muted">{hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold">What has to be done first?</span>
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-pressed={draft.groups.includes(g.id)}
                onClick={() => onChange({ ...draft, groups: toggle(draft.groups, g.id) })}
                className={`min-h-[48px] rounded-xl border px-3 text-sm font-semibold ${
                  draft.groups.includes(g.id)
                    ? "border-accent bg-surface"
                    : "border-line bg-surface/50"
                }`}
              >
                {g.name}
              </button>
            ))}
            {groups.length === 0 && (
              <p className="text-sm text-muted">
                No sets of jobs exist yet to attach.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onSave}
            className="min-h-[48px] rounded-xl bg-accent px-5 font-[family-name:var(--font-display)] text-base font-semibold text-white disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-[48px] rounded-xl border border-line px-5 text-base font-semibold"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
