import { getSupabaseClient } from "@/lib/supabase/client";
import { getActor } from "./kiosk";

/**
 * Typed wrappers over the task functions.
 *
 * Every one of these is a call to a Postgres SECURITY DEFINER function, never
 * a table write. That is the whole architecture in one file: with no
 * application server (HAL-1538 §2.4), those functions are where authority,
 * attribution and concurrency live, and the client's job is only to ask.
 *
 * Each mutation carries an operation id and the version it expects, which is
 * what makes a flaky connection safe on a phone in a kitchen:
 *
 *   - a retry of the same tap returns the first result, unchanged;
 *   - two children tapping the same shared task both succeed, and one of them
 *     is credited;
 *   - a retry that arrives after a parent sent the task back is refused rather
 *     than silently undoing the correction.
 */

export type TaskState =
  | "pending"
  | "in_progress"
  | "submitted"
  | "completed"
  | "needs_attention"
  | "not_applicable";

/** What happened, so the UI can say something true about it. */
export type TransitionOutcome =
  /** This call made the change. */
  | "applied"
  /** The same operation id had already been recorded; nothing changed. */
  | "replayed"
  /** Someone else got there first and the task is already where you wanted it. */
  | "already_satisfied";

export interface TransitionResult {
  instance_id: string;
  state: TaskState;
  completed_by: string | null;
  completed_at: string | null;
  version: number;
  outcome: TransitionOutcome;
}

/** Raised when the task moved under you in a way that matters. */
export class TaskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskConflictError";
  }
}

async function callTransition(
  fn: string,
  args: Record<string, unknown>,
): Promise<TransitionResult> {
  // Whoever is standing at the iPad is attributed with the work, so a child's
  // tap is recorded as theirs rather than as the parent whose session happens
  // to be open on the kitchen tablet. The token is passed, never trusted: the
  // database re-checks the session, the device and the household on every
  // call, and an actor token never carries parent authority.
  const actor = getActor();
  const { data, error } = await getSupabaseClient().rpc(fn, {
    p_operation_id: crypto.randomUUID(),
    p_actor_token: actor?.token ?? null,
    ...args,
  });

  if (error) {
    // 40001 is the serialization failure the transition function raises when a
    // stale write would move the task somewhere it no longer belongs.
    if (error.code === "40001") throw new TaskConflictError(error.message);
    throw new Error(error.message);
  }
  return data as TransitionResult;
}

export const tasks = {
  /** Create today's instances. Safe to call from every device, every load. */
  async ensureDay(householdId: string, localDate: string): Promise<number> {
    const { data, error } = await getSupabaseClient().rpc("ensure_day_materialized", {
      p_household_id: householdId,
      p_local_date: localDate,
    });
    if (error) throw new Error(error.message);
    return data as number;
  },

  start: (instanceId: string, expectedVersion?: number) =>
    callTransition("start_task_instance", {
      p_instance_id: instanceId,
      p_expected_version: expectedVersion ?? null,
    }),

  /** Hand it in for a parent to check. */
  submit: (instanceId: string, expectedVersion?: number) =>
    callTransition("submit_task_instance", {
      p_instance_id: instanceId,
      p_expected_version: expectedVersion ?? null,
    }),

  /** Mark it done. Refused if the task's revision requires a parent's check. */
  complete: (instanceId: string, expectedVersion?: number) =>
    callTransition("complete_task_instance", {
      p_instance_id: instanceId,
      p_expected_version: expectedVersion ?? null,
    }),

  /** Parent only. The child who submitted keeps the credit. */
  approve: (instanceId: string, expectedVersion?: number) =>
    callTransition("approve_task_instance", {
      p_instance_id: instanceId,
      p_expected_version: expectedVersion ?? null,
    }),

  /** Parent only. The note is what the child reads, so it should be kind. */
  returnForCorrection: (instanceId: string, note: string, expectedVersion?: number) =>
    callTransition("return_task_instance", {
      p_instance_id: instanceId,
      p_note: note,
      p_expected_version: expectedVersion ?? null,
    }),

  /** Parent only. Excuses the task without anyone having to pretend it was done. */
  exempt: (instanceId: string, note: string, expectedVersion?: number) =>
    callTransition("exempt_task_instance", {
      p_instance_id: instanceId,
      p_note: note,
      p_expected_version: expectedVersion ?? null,
    }),

  /** Only where the task's revision allows it — not a general escape hatch. */
  markNotNeeded: (instanceId: string, expectedVersion?: number) =>
    callTransition("mark_task_not_needed", {
      p_instance_id: instanceId,
      p_expected_version: expectedVersion ?? null,
    }),
};
