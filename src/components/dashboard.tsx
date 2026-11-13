"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  useDashboard,
  type DashboardActivity,
  type DashboardFloor,
  type DashboardPayload,
  type PetCare,
} from "@/lib/dashboard";
import type { ReadinessResult, SpaceStatus } from "@/lib/readiness";

/**
 * The mounted-iPad dashboard.
 *
 * Every status here is rendered with a word as well as a colour. Two of the
 * three children are too young to rely on a colour alone, one of the adults
 * may not distinguish green from amber, and the thing is read from across a
 * kitchen — so "Needs attention" is written out next to the dot, always.
 */

const SPACE_LABEL: Record<SpaceStatus, string> = {
  ready: "Ready",
  in_progress: "In progress",
  awaiting_review: "Awaiting review",
  needs_attention: "Needs attention",
};

const SPACE_TONE: Record<SpaceStatus, string> = {
  ready: "border-[color:var(--color-done)]/30 bg-done-wash text-[color:var(--color-done)]",
  in_progress: "border-line bg-surface text-muted",
  awaiting_review: "border-accent-line bg-accent-wash text-accent-strong",
  needs_attention: "border-attention-line bg-attention-wash text-attention-ink",
};

/**
 * The signed-in session's household.
 *
 * It resolves to "none" as a real outcome, not just an absence. A session
 * whose user no longer exists, or an account not linked to a family member,
 * returns no rows — and an earlier version left the screen on "Loading the
 * house…" forever in that case. On a tablet nobody is watching, a permanent
 * spinner is the worst possible answer.
 */
function useHouseholdId() {
  const [state, setState] = useState<
    { status: "loading" } | { status: "found"; id: string } | { status: "none" }
  >({ status: "loading" });

  useEffect(() => {
    void (async () => {
      const { data, error } = await getSupabaseClient()
        .from("households")
        .select("id")
        .maybeSingle();
      if (error || !data) setState({ status: "none" });
      else setState({ status: "found", id: data.id });
    })();
  }, []);

  return state;
}

function greeting(localDate: string, inMorning: boolean): string {
  if (inMorning) return "Good morning";
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
  void localDate;
}

export function Dashboard() {
  const household = useHouseholdId();
  const { data, error, loading } = useDashboard(
    household.status === "found" ? household.id : null,
  );

  if (household.status === "none") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-5">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold">
          No household for this account
        </h1>
        <p className="text-muted">
          This sign-in is not linked to a family member yet. A parent can link
          it, or sign out and use a different account.
        </p>
        <button
          type="button"
          onClick={() => getSupabaseClient().auth.signOut()}
          className="min-h-[48px] rounded-xl border border-line bg-surface px-4 font-semibold"
        >
          Sign out
        </button>
      </main>
    );
  }

  if ((loading || household.status === "loading") && !data) {
    return (
      <output aria-live="polite" className="flex min-h-screen items-center justify-center text-muted">
        Loading the house…
      </output>
    );
  }
  if (error) {
    return (
      <p role="alert" className="m-6 rounded-[var(--radius-card)] border border-attention-line bg-attention-wash px-4 py-3 text-attention-ink">
        {error}
      </p>
    );
  }
  if (!data) return null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <Header data={data} />

      <section aria-label="Family" className="mt-6">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data.members.map((m) => (
            <li
              key={m.id}
              className="flex flex-col items-center gap-1.5 rounded-[var(--radius-card)] border border-line border-b-[3px] bg-surface px-3 py-4"
            >
              <span
                aria-hidden="true"
                className="flex h-12 w-12 items-center justify-center rounded-full border-2 text-2xl"
                style={{ borderColor: m.accent_color ?? "var(--color-line)" }}
              >
                {m.avatar_emoji ?? "🙂"}
              </span>
              <span className="font-[family-name:var(--font-display)] text-base font-semibold">
                {m.display_name}
              </span>
              {/* "all done" is only honest when they HAD something to do.
                  With nothing of their own today, say so — otherwise five
                  green ticks sit above an untouched house. */}
              <span
                className={
                  m.own_total === 0
                    ? "text-xs font-medium text-muted"
                    : m.own_outstanding === 0
                      ? "text-xs font-medium text-[color:var(--color-done)]"
                      : "text-xs font-medium text-attention-ink"
                }
              >
                {m.own_total === 0
                  ? "nothing of their own"
                  : m.own_outstanding === 0
                    ? "all done"
                    : `${m.own_outstanding} left`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1.45fr_1fr]">
        <div className="flex flex-col gap-5">
          {data.activities.map((a) => (
            <ActivityCard key={a.id} activity={a} members={data.members} />
          ))}
          <HouseCard data={data} />
        </div>

        <div className="flex flex-col gap-5">
          {data.pets.map((p) => (
            <PetCard key={p.id} name={p.name} emoji={p.avatar_emoji} care={p.care} />
          ))}
          <ShoppingCard items={data.shopping} />
        </div>
      </div>
    </main>
  );
}

function Header({ data }: { data: DashboardPayload }) {
  const pretty = new Date(`${data.local_date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-4xl">
          {greeting(data.local_date, data.in_morning_window)}
        </h1>
        <p className="mt-1 text-base text-muted">{pretty}</p>
      </div>
      <div className="flex items-center gap-3">
        {data.in_morning_window && (
          <p className="flex items-center gap-2.5 rounded-full border border-attention-line bg-attention-wash px-4 py-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[color:var(--color-attention)]" />
            <span className="text-sm font-semibold text-attention-ink">
              School morning
              {data.morning_window_end ? ` · until ${data.morning_window_end.slice(0, 5)}` : ""}
            </span>
          </p>
        )}
        <button
          type="button"
          onClick={() => getSupabaseClient().auth.signOut()}
          className="min-h-[44px] rounded-xl border border-line bg-surface px-4 text-sm font-semibold"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

function ActivityCard({
  activity,
  members,
}: {
  activity: DashboardActivity;
  members: { id: string; display_name: string; avatar_emoji: string | null }[];
}) {
  // One tile per child: the same activity is legitimately ready for one and
  // not another, so a single household answer would be wrong for someone.
  //
  // Each tile MUST name its child. Unlabelled, three tiles that happen to
  // agree read as the same list printed three times — which is how this
  // first looked on the wall, and a fair reading of it.
  const nameOf = new Map(members.map((m) => [m.id, m]));
  return (
    <section
      aria-labelledby={`activity-${activity.id}`}
      className="rounded-[var(--radius-card)] border border-line bg-surface p-5"
    >
      <h2
        id={`activity-${activity.id}`}
        className="flex items-center gap-3 font-[family-name:var(--font-display)] text-xl font-semibold"
      >
        <span aria-hidden="true" className="text-2xl">
          {activity.icon}
        </span>
        {activity.name}
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {activity.per_member.map((r) => (
          <li key={r.member_id}>
            <ReadinessTile result={r} member={nameOf.get(r.member_id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReadinessTile({
  result,
  member,
}: {
  result: ReadinessResult;
  member?: { display_name: string; avatar_emoji: string | null };
}) {
  const ready = result.status === "ready_to_ask" || result.status === "approved";
  const label =
    result.status === "approved"
      ? "Yes — go ahead"
      : result.status === "ready_to_ask"
        ? "Ready to ask"
        : result.status === "temporarily_unavailable"
          ? "Not right now"
          : `${result.blocking.length} thing${result.blocking.length === 1 ? "" : "s"} left`;

  return (
    <div
      className={`h-full rounded-2xl border p-3 ${
        ready
          ? "border-[color:var(--color-done)]/30 bg-done-wash"
          : "border-attention-line bg-attention-wash"
      }`}
    >
      {member && (
        <p className="mb-1.5 flex items-center gap-1.5 font-[family-name:var(--font-display)] text-sm font-semibold">
          {member.avatar_emoji && (
            <span aria-hidden="true">{member.avatar_emoji}</span>
          )}
          {member.display_name}
        </p>
      )}
      <p className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2 w-2 flex-none rounded-full ${
            ready ? "bg-[color:var(--color-done)]" : "bg-[color:var(--color-attention)]"
          }`}
        />
        <span
          className={`text-sm font-semibold ${
            ready ? "text-[color:var(--color-done)]" : "text-attention-ink"
          }`}
        >
          {label}
        </span>
      </p>

      {result.reasons.length > 0 && (
        <p className="mt-1.5 text-xs text-muted">{result.reasons[0]}</p>
      )}

      {result.blocking.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {result.blocking.slice(0, 3).map((b, i) => (
            <li key={`${b.link_id}-${i}`}>
              <Link
                href={b.link_kind === "space" ? `/house/?space=${b.link_id}` : "/tasks/"}
                className="flex min-h-[32px] items-center gap-1.5 text-xs font-medium text-accent hover:text-accent-strong"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true" className="flex-none">
                  <path d="M9 18l6-6-6-6" />
                </svg>
                {b.reason}
              </Link>
            </li>
          ))}
          {result.blocking.length > 3 && (
            <li className="text-xs text-muted">and {result.blocking.length - 3} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function HouseCard({ data }: { data: DashboardPayload }) {
  const { done, total } = data.progress;
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  return (
    <section aria-labelledby="house-heading" className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="house-heading" className="font-[family-name:var(--font-display)] text-sm font-semibold uppercase tracking-wider text-muted">
          The house
        </h2>
        <p className="text-sm text-muted">
          {done} of {total} jobs done
        </p>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" role="presentation">
        <div className="h-full rounded-full bg-[color:var(--color-done)]" style={{ width: `${pct}%` }} />
      </div>

      {data.floors.map((floor: DashboardFloor) => (
        <div key={floor.id} className="mt-4">
          <h3 className="mb-2 text-xs font-semibold text-muted">{floor.name}</h3>
          <ul className="flex flex-wrap gap-2">
            {floor.rooms.map((room) => (
              <li key={room.space_id}>
                <Link
                  href={`/house/?space=${room.space_id}`}
                  className={`flex min-h-[44px] items-center gap-2 rounded-xl border px-3 py-2 text-sm ${SPACE_TONE[room.status]}`}
                >
                  <span aria-hidden="true">{room.icon}</span>
                  <span className="font-medium text-ink">{room.name}</span>
                  <span className="text-xs font-semibold">{SPACE_LABEL[room.status]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PetCard({ name, emoji, care }: { name: string; emoji: string | null; care: PetCare[] }) {
  return (
    <section aria-labelledby="pet-heading" className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <div className="mb-3 flex items-center gap-3">
        <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-wash text-xl">
          {emoji ?? "🐾"}
        </span>
        <div>
          <h2 id="pet-heading" className="font-[family-name:var(--font-display)] text-lg font-semibold">
            {name}
          </h2>
          <p className="text-xs text-muted">Anyone can do these</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {care.map((c) => {
          const done = c.satisfaction === "satisfied";
          return (
            <li key={c.instance_id} className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border-2 ${
                  done
                    ? "border-[color:var(--color-done)]/50 bg-done-wash"
                    : "border-line bg-surface"
                }`}
              >
                {done && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-done)" strokeWidth="4" strokeLinecap="round" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </span>
              <span className="flex-1 text-sm font-medium">{c.title}</span>
              <span className={`text-xs ${done ? "text-[color:var(--color-done)]" : "text-muted"}`}>
                {/* Who and when, so nobody feeds the dog twice. */}
                {done && c.by ? `${c.by} · ${c.at_local ?? ""}` : "not yet"}
              </span>
            </li>
          );
        })}
        {care.length === 0 && <li className="text-sm text-muted">Nothing needed today.</li>}
      </ul>
    </section>
  );
}

function ShoppingCard({ items }: { items: DashboardPayload["shopping"] }) {
  const out = items.filter((i) => i.list_kind === "out_of");
  const wish = items.filter((i) => i.list_kind === "would_like");
  return (
    <section aria-labelledby="shopping-heading" className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
      <h2 id="shopping-heading" className="font-[family-name:var(--font-display)] text-sm font-semibold uppercase tracking-wider text-muted">
        We&rsquo;re out of
      </h2>
      <ul className="mt-3 flex flex-col gap-1.5">
        {out.map((i) => (
          <li key={i.id} className="text-sm">
            <span className="font-medium">{i.name}</span>{" "}
            <span className="text-xs text-muted">· {i.by}</span>
          </li>
        ))}
        {out.length === 0 && <li className="text-sm text-muted">Nothing on the list.</li>}
      </ul>
      {wish.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted">
            I&rsquo;d like
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {wish.map((i) => (
              <li key={i.id} className="text-sm">
                <span className="font-medium">{i.name}</span>{" "}
                <span className="text-xs text-muted">· {i.by}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
