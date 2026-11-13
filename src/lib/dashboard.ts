"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { ReadinessResult, SpaceResult } from "@/lib/readiness";

export interface DashboardMember {
  id: string;
  display_name: string;
  role: "parent" | "child";
  avatar_emoji: string | null;
  accent_color: string | null;
  /** Outstanding tasks that are this member's own, not the household's. */
  own_outstanding: number;
  /** How many of their own apply at all right now. Zero is not "all done". */
  own_total: number;
}

export interface DashboardRoom extends SpaceResult {
  icon: string | null;
  display_order: number;
}

export interface DashboardFloor {
  id: string;
  name: string;
  icon: string | null;
  rooms: DashboardRoom[];
}

export interface DashboardActivity {
  id: string;
  name: string;
  icon: string | null;
  per_member: ReadinessResult[];
}

export interface PetCare {
  instance_id: string;
  title: string;
  state: string;
  satisfaction: string;
  not_applicable_reason: string | null;
  by: string | null;
  at_local: string | null;
}

export interface DashboardPayload {
  household: { id: string; name: string; timezone: string };
  evaluated_at: string;
  local_date: string;
  in_morning_window: boolean;
  morning_window_end: string | null;
  members: DashboardMember[];
  floors: DashboardFloor[];
  activities: DashboardActivity[];
  pets: { id: string; name: string; avatar_emoji: string | null; care: PetCare[] }[];
  shopping: { id: string; name: string; list_kind: string; by: string }[];
  progress: { done: number; total: number };
}

export async function fetchDashboard(
  householdId: string,
  at: Date = new Date(),
): Promise<DashboardPayload> {
  const { data, error } = await getSupabaseClient().rpc("evaluate_household_dashboard", {
    p_household_id: householdId,
    p_evaluated_at: at.toISOString(),
  });
  if (error) throw new Error(error.message);
  return data as DashboardPayload;
}

/** Wall-clock parts in the household's timezone, not the device's. */
function localParts(timezone: string, at: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

/**
 * Milliseconds until the dashboard could change on its own.
 *
 * Readiness is derived from a moment, so two things alter it with no row
 * changing: the end of the school-morning window, and midnight. A tablet left
 * on a kitchen wall sits through both. Without this it would still be
 * offering yesterday's lunch at ten in the morning.
 */
export function msUntilNextBoundary(
  timezone: string,
  morningWindowEnd: string | null,
  at: Date = new Date(),
): number {
  const { seconds } = localParts(timezone, at);
  const candidates: number[] = [24 * 3600]; // midnight

  if (morningWindowEnd) {
    const [h, m] = morningWindowEnd.split(":").map(Number);
    candidates.push(h * 3600 + m * 60);
  }

  const next = candidates
    .map((s) => (s > seconds ? s - seconds : 24 * 3600 - seconds + s))
    .reduce((a, b) => Math.min(a, b));

  // A second's grace, so the refresh lands after the boundary rather than on it.
  return (next + 1) * 1000;
}

/**
 * The dashboard, kept current.
 *
 * Three things can make it stale and all three are handled here, because any
 * one of them left out shows a family the wrong house:
 *   - someone finishes a task on another device (a row changes);
 *   - the morning window closes or the day rolls over (no row changes);
 *   - the tablet wakes from sleep or the network returns.
 */
export function useDashboard(householdId: string | null) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const boundaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!householdId) return;
    try {
      const payload = await fetchDashboard(householdId);
      setData(payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [householdId]);

  useEffect(() => {
    if (!householdId) return;
    const supabase = getSupabaseClient();

    // Row changes. The payload is recomputed server-side rather than patched
    // here: readiness has one implementation and this is not it.
    const channel = supabase
      .channel(`household:${householdId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_instances" },
        () => void refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shopping_items" },
        () => void refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "calendar_events" },
        () => void refresh(),
      )
      // The first load happens once the subscription is live, not before it.
      // Fetching first would leave a gap: a task completed in those few
      // milliseconds would change no row we were listening to yet, and the
      // iPad would sit there showing work that was already done.
      .subscribe((status) => {
        if (status === "SUBSCRIBED") void refresh();
      });

    const onWake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      void supabase.removeChannel(channel);
    };
  }, [householdId, refresh]);

  // Re-ask at the next moment the answer could change by itself.
  useEffect(() => {
    if (!data) return;
    if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    boundaryTimer.current = setTimeout(
      () => void refresh(),
      msUntilNextBoundary(data.household.timezone, data.morning_window_end),
    );
    return () => {
      if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    };
  }, [data, refresh]);

  return { data, error, loading, refresh };
}
