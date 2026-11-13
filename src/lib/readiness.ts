import { getSupabaseClient } from "@/lib/supabase/client";

/**
 * Readiness, as the client sees it.
 *
 * There is exactly one implementation of these rules and it is in Postgres
 * (HAL-1538 §2.4). This file asks the question and types the answer; it must
 * never work the answer out for itself. A second copy in the bundle would be
 * the same defect as a second stored copy of a fact — two implementations
 * drifting apart, and two clients on different bundle versions disagreeing
 * about the same task.
 */

export type ReadinessStatus =
  /** Something is still outstanding. `blocking` says what and where. */
  | "not_ready"
  /** Everything required is done. Permission may still be a separate matter. */
  | "ready_to_ask"
  /** A parent has actually granted it. Only reachable via an activity grant. */
  | "approved"
  /** Not at this time of day, whatever the state of the house. */
  | "temporarily_unavailable";

export type BlockerReason =
  | "incomplete"
  | "returned_for_correction"
  | "pending_review"
  | "missing_instance";

export interface Blocker {
  reason_code: BlockerReason;
  /** A sentence a seven-year-old can act on, e.g. "Boys' Bedroom needs attention." */
  reason: string;
  /** Where to send them: a room or a single task. */
  link_kind: "space" | "task";
  link_id: string;
  link_name: string;
  title: string;
  group_id: string;
  group_name: string;
}

export interface ReadinessResult {
  status: ReadinessStatus;
  activity: { id: string; name: string; icon: string | null };
  member_id: string;
  evaluated_at: string;
  local_date: string;
  applicable_count: number;
  groups: { id: string; name: string }[];
  blocking: Blocker[];
  satisfied: { title: string; link_kind: string; link_id: string; link_name: string }[];
  pending_reviews: { title: string; link_kind: string; link_id: string }[];
  exemptions: { title: string; instance_id: string }[];
  /** Present when the status needs saying in words, e.g. nothing is required. */
  reasons: string[];
}

export type SpaceStatus =
  | "ready"
  | "in_progress"
  | "awaiting_review"
  | "needs_attention";

export interface SpaceResult {
  space_id: string;
  name: string;
  status: SpaceStatus;
  applicable: number;
  satisfied: number;
  awaiting_review: number;
  returned: number;
  note: string | null;
}

/**
 * Can this member do this activity, and if not, what is left?
 *
 * `memberId` is required and has no household-wide value: readiness is always
 * one person's question. The shared dashboard renders one card per member
 * rather than a single answer for the house, because the same activity can
 * legitimately be ready for one child and not another.
 */
export async function evaluateActivityReadiness(
  householdId: string,
  memberId: string,
  activityId: string,
  evaluatedAt: Date = new Date(),
): Promise<ReadinessResult> {
  const { data, error } = await getSupabaseClient().rpc("evaluate_activity_readiness", {
    p_household_id: householdId,
    p_member_id: memberId,
    p_activity_id: activityId,
    p_evaluated_at: evaluatedAt.toISOString(),
  });
  if (error) throw new Error(error.message);
  return data as ReadinessResult;
}

/** The derived status of one room, at this moment. */
export async function evaluateSpaceStatus(
  spaceId: string,
  evaluatedAt: Date = new Date(),
): Promise<SpaceResult> {
  const { data, error } = await getSupabaseClient().rpc("evaluate_space_status", {
    p_space_id: spaceId,
    p_evaluated_at: evaluatedAt.toISOString(),
  });
  if (error) throw new Error(error.message);
  return data as SpaceResult;
}

/**
 * The wording the brief asks for: tell them what is left, not just "no".
 * Kept here so every surface says the same thing.
 */
export function describeReadiness(result: ReadinessResult): string {
  switch (result.status) {
    case "approved":
      return "Yes — go ahead.";
    case "ready_to_ask":
      return result.applicable_count === 0
        ? "Nothing needed first."
        : "Everything's done — you can ask.";
    case "temporarily_unavailable":
      return result.reasons[0] ?? "Not at this time of day.";
    case "not_ready": {
      const n = result.blocking.length;
      return n === 1 ? "One thing left" : `${n} things left`;
    }
  }
}
