"use client";

import Link from "next/link";
import { MemberBadge } from "@/components/member-badge";
import type { DashboardMember, DashboardPayload } from "@/lib/dashboard";
import type { Blocker, ReadinessResult } from "@/lib/readiness";

/**
 * The board, arranged by PERSON rather than by activity.
 *
 * The old arrangement was one card per activity with a tile per child inside
 * it, and it produced the screenshot that killed the last version: "Play
 * Video Games" and "Watch TV" rendered as two cards with byte-for-byte
 * identical contents — the same four house jobs, the same three children, the
 * same verdict three times each. Twelve tiles carrying two facts.
 *
 * Inverting the axis fixes it structurally rather than cosmetically:
 *
 *   THE HOUSE IS SAID ONCE, at the top, because it is one fact about the
 *   house and not five facts about five people.
 *
 *   EACH PERSON APPEARS ONCE, with their own work and their own list.
 *
 *   ACTIVITIES ARE GROUPED BY WHAT IS LEFT, not listed one per card. Four
 *   things that all unlock when the kitchen is done are one sentence with
 *   four names in it, not four paragraphs. This is the part that cannot
 *   regress: as long as activities are grouped by their remaining condition,
 *   two activities with the same condition can never print twice.
 */

export function PeopleBoard({ data }: { data: DashboardPayload }) {
  const children = data.members.filter((m) => m.role === "child");
  const parents = data.members.filter((m) => m.role === "parent");

  // Every readiness answer, filed under the person it was computed for.
  const byMember = new Map<string, ReadinessResult[]>();
  for (const activity of data.activities) {
    for (const result of activity.per_member) {
      const list = byMember.get(result.member_id);
      if (list) list.push(result);
      else byMember.set(result.member_id, [result]);
    }
  }

  const house = houseBlockers(data);

  return (
    <div className="flex flex-col gap-4">
      {house.length > 0 && <HousePanel blockers={house} />}

      <ul className="flex flex-col gap-4">
        {children.map((child) => (
          <li key={child.id}>
            <PersonCard member={child} results={byMember.get(child.id) ?? []} />
          </li>
        ))}
      </ul>

      {parents.some((p) => (p.own_total ?? 0) > 0) && <ParentStrip parents={parents} />}
    </div>
  );
}

/**
 * The house's own outstanding work, collected once across everybody.
 *
 * A household-scope blocker is the same fact however many people it is
 * reported to, so it is de-duplicated by what it points at rather than by the
 * sentence describing it — two activities phrase the same room differently.
 */
function houseBlockers(data: DashboardPayload): Blocker[] {
  const seen = new Map<string, Blocker>();
  for (const activity of data.activities) {
    for (const result of activity.per_member) {
      for (const b of result.blocking) {
        if (b.scope !== "household") continue;
        const key = `${b.link_kind}:${b.link_id}`;
        if (!seen.has(key)) seen.set(key, b);
      }
    }
  }
  return [...seen.values()];
}

function HousePanel({ blockers }: { blockers: Blocker[] }) {
  return (
    <section
      aria-labelledby="house-needs"
      className="rounded-[var(--radius-card)] border border-attention-line bg-attention-wash p-4 sm:p-5"
    >
      <h2
        id="house-needs"
        className="font-[family-name:var(--font-display)] text-base font-semibold text-attention-ink"
      >
        The house needs {blockers.length}
        {blockers.length === 1 ? " thing" : " things"}
      </h2>
      <p className="mt-0.5 text-sm text-attention-ink/80">
        This is everybody&rsquo;s, so anyone can do it.
      </p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {blockers.map((b) => (
          <li key={`${b.link_kind}-${b.link_id}`}>
            <Link
              href={blockerHref(b)}
              className="inline-flex min-h-[40px] items-center rounded-full border border-attention-line bg-surface px-4 text-sm font-semibold text-attention-ink"
            >
              {b.link_name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Where a blocker should actually send someone.
 *
 * Anything that was not a room used to go to /tasks/, which is not a route in
 * this app — so most of a school morning's blockers, Lucy's four jobs
 * included, were dead links on the main screen.
 */
function blockerHref(b: Blocker): string {
  if (b.link_kind === "space") return `/house/?space=${b.link_id}`;
  if (b.link_kind === "pet") return "/lucy/";
  // A personal job: My jobs lists both their own and the shared ones.
  return "/me/";
}

/** What is still standing between this person and this activity. */
interface Condition {
  /** Stable identity, so activities needing the same things group together. */
  key: string;
  house: boolean;
  /** How many of the asking child's own jobs are outstanding. */
  own: number;
  /** Teammates who have not finished, by name. */
  waitingOn: string[];
  unavailable: boolean;
}

function conditionOf(result: ReadinessResult, memberId: string): Condition {
  if (result.status === "temporarily_unavailable") {
    return { key: "unavailable", house: false, own: 0, waitingOn: [], unavailable: true };
  }
  let house = false;
  const ownKeys = new Set<string>();
  const waiting = new Set<string>();
  for (const b of result.blocking) {
    if (b.scope === "household") {
      house = true;
    } else if (b.for_member_id === memberId) {
      ownKeys.add(`${b.link_kind}:${b.link_id}:${b.title}`);
    } else if (b.for_member_name) {
      waiting.add(b.for_member_name);
    }
  }
  const waitingOn = [...waiting].sort();
  return {
    key: `${house ? "h" : ""}|${ownKeys.size}|${waitingOn.join(",")}`,
    house,
    own: ownKeys.size,
    waitingOn,
    unavailable: false,
  };
}

function isReady(c: Condition): boolean {
  return !c.unavailable && !c.house && c.own === 0 && c.waitingOn.length === 0;
}

/** "the house, your 2 jobs and Roland" — the sentence, built from the parts. */
function conditionLabel(c: Condition): string {
  if (c.unavailable) return "Not at this time of day";
  if (isReady(c)) return "Ready now";

  const parts: string[] = [];
  if (c.house) parts.push("the house");
  if (c.own > 0) parts.push(c.own === 1 ? "your 1 job" : `your ${c.own} jobs`);
  // "to finish" matters: without it the line reads "needs the house and
  // Roland", which sounds like Roland is a prerequisite object rather than a
  // person with two things left to do.
  if (c.waitingOn.length > 0) parts.push(`${joinNames(c.waitingOn)} to finish`);

  return `Needs ${joinParts(parts)}`;
}

function joinNames(names: string[]): string {
  return names.length === 1 ? names[0] : joinParts(names);
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one-line answer for this person, before any detail.
 *
 * Verdict first: a child wants "yes" or "what's left", not a number they have
 * to interpret. "13 things" is a single demoralising figure with no shape.
 */
function verdictOf(member: DashboardMember, conditions: Condition[]): {
  text: string;
  tone: "good" | "attention" | "quiet";
} {
  if (conditions.some(isReady)) return { text: "Good to go", tone: "good" };
  if (member.own_outstanding > 0) {
    return {
      text: `${member.own_outstanding} of yours left`,
      tone: "attention",
    };
  }
  if (conditions.some((c) => c.waitingOn.length > 0)) {
    const names = [...new Set(conditions.flatMap((c) => c.waitingOn))].sort();
    return { text: `Waiting for ${joinNames(names)}`, tone: "attention" };
  }
  if (conditions.some((c) => c.house)) return { text: "Just the house", tone: "attention" };
  if (conditions.length === 0) {
    return {
      text: member.own_total === 0 ? "Nothing to do today" : "All done",
      tone: member.own_total === 0 ? "quiet" : "good",
    };
  }
  return { text: "All done", tone: "good" };
}

const TONE: Record<"good" | "attention" | "quiet", string> = {
  good: "text-[color:var(--color-done)]",
  attention: "text-attention-ink",
  quiet: "text-muted",
};

function PersonCard({
  member,
  results,
}: {
  member: DashboardMember;
  results: ReadinessResult[];
}) {
  // Group this person's activities by what is left before each one opens.
  const groups = new Map<string, { condition: Condition; results: ReadinessResult[] }>();
  for (const r of results) {
    const condition = conditionOf(r, member.id);
    const group = groups.get(condition.key);
    if (group) group.results.push(r);
    else groups.set(condition.key, { condition, results: [r] });
  }
  // Ready first — the answer a child came for goes at the top of their card.
  const ordered = [...groups.values()].sort((a, b) => {
    if (isReady(a.condition) !== isReady(b.condition)) return isReady(a.condition) ? -1 : 1;
    return a.condition.key.localeCompare(b.condition.key);
  });

  const verdict = verdictOf(member, ordered.map((g) => g.condition));

  return (
    <section
      aria-labelledby={`person-${member.id}`}
      className="rounded-[var(--radius-card)] border border-line border-b-[3px] bg-surface p-4 sm:p-5"
    >
      <div className="flex items-center gap-3">
        <MemberBadge person={member} size="lg" />
        <div className="min-w-0 flex-1">
          <h2
            id={`person-${member.id}`}
            className="font-[family-name:var(--font-display)] text-xl font-semibold"
          >
            {member.display_name}
          </h2>
          <p className={`text-sm font-semibold ${TONE[verdict.tone]}`}>{verdict.text}</p>
        </div>
        {member.own_outstanding > 0 && (
          <Link
            href="/me/"
            className="inline-flex min-h-[44px] flex-none items-center rounded-2xl bg-accent px-4 font-[family-name:var(--font-display)] text-sm font-semibold text-white"
          >
            Their jobs
          </Link>
        )}
      </div>

      {ordered.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2.5">
          {ordered.map((group) => (
            <li
              key={group.condition.key}
              className={`rounded-2xl border p-3 ${
                isReady(group.condition)
                  ? "border-[color:var(--color-done)]/35 bg-[color:var(--color-done)]/8"
                  : "border-line bg-ground"
              }`}
            >
              <p
                className={`text-xs font-semibold uppercase tracking-wider ${
                  isReady(group.condition)
                    ? "text-[color:var(--color-done)]"
                    : "text-muted"
                }`}
              >
                {conditionLabel(group.condition)}
              </p>
              <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {group.results.map((r) => (
                  <li
                    key={r.activity.id}
                    className="flex items-center gap-1.5 text-sm font-semibold"
                  >
                    <span aria-hidden="true">{r.activity.icon}</span>
                    {/* The name is its own element rather than a bare text
                        node beside the icon, so it can be addressed on its
                        own — by a test, and by a screen reader reading the
                        activity rather than "games controller Switch". */}
                    <span>{r.activity.name}</span>
                    {/* A team activity says so, because "waiting for Roland"
                        only makes sense once you know it is a shared one. */}
                    {r.participation === "team" && (
                      <span className="rounded-full bg-accent-wash px-2 py-0.5 text-[11px] font-semibold text-accent">
                        together
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {ordered.length === 0 && (
        <p className="mt-3 text-sm text-muted">
          Nothing is set up for {member.display_name} yet — a parent can choose
          what they can do in Settings.
        </p>
      )}
    </section>
  );
}

/**
 * The adults, in one line.
 *
 * Parents have no activity list — the gate is not aimed at them — but their
 * own jobs still count toward the house, so hiding them entirely would make
 * the household progress bar look wrong. One quiet line, and only when they
 * actually have something today.
 */
function ParentStrip({ parents }: { parents: DashboardMember[] }) {
  return (
    <section
      aria-label="Grown-ups"
      className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3"
    >
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {parents
          .filter((p) => p.own_total > 0)
          .map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-sm">
              <MemberBadge person={p} size="sm" />
              <span className="font-semibold">{p.display_name}</span>
              <span
                className={
                  p.own_outstanding === 0
                    ? "text-[color:var(--color-done)]"
                    : "text-muted"
                }
              >
                {p.own_outstanding === 0 ? "all done" : `${p.own_outstanding} left`}
              </span>
            </li>
          ))}
      </ul>
    </section>
  );
}
