import { getSupabaseClient } from "./supabase/client";

/**
 * Who is standing at the iPad, and on which iPad.
 *
 * Two separate things live here, and they are not the same kind of secret:
 *
 *   THE DEVICE. Enrolled once by a parent, then remembered forever in this
 *   browser. Knowing a device id grants nothing on its own — every function
 *   that accepts one re-checks that it belongs to the caller's household and
 *   is still active, so a revoked iPad stops working on its next request.
 *
 *   THE ACTOR TOKEN. Minted by entering a child's PIN on an enrolled device,
 *   short-lived, and deliberately WEAKER than a parent's session: an actor
 *   token never confers parent authority, not even one minted from a parent's
 *   own PIN. It says "Desmond is at the iPad", nothing more.
 *
 * Both live in localStorage because a wall-mounted iPad is reloaded, slept
 * and woken constantly, and a family hub that forgets who you are every time
 * the screen turns off is not usable. Neither is a bearer credential for
 * anything a browser could not already do: the device is useless without a
 * PIN, and the token is useless off this household's data.
 */

const DEVICE_KEY = "ofh.device_id";
const ACTOR_KEY = "ofh.actor";

export interface Actor {
  memberId: string;
  displayName: string;
  token: string;
  /** Epoch milliseconds. The database enforces this too; this is for the UI. */
  expiresAt: number;
}

/** localStorage throws in private mode and when site data is blocked. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // A kiosk that cannot remember is worse, not broken. Carry on.
  }
}

export function getDeviceId(): string | null {
  return read(DEVICE_KEY);
}

export function isEnrolled(): boolean {
  return getDeviceId() !== null;
}

/**
 * Enrol the iPad in your hands. Parent-only, enforced in the database.
 *
 * The id is remembered here so the children never see this step again.
 */
export async function enrollThisDevice(label: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc("enroll_this_device", {
    p_label: label,
  });
  if (error) throw new Error(error.message);
  const deviceId = data as string;
  write(DEVICE_KEY, deviceId);
  return deviceId;
}

export function forgetThisDevice() {
  write(DEVICE_KEY, null);
  clearActor();
}

export function getActor(): Actor | null {
  const raw = read(ACTOR_KEY);
  if (!raw) return null;
  try {
    const actor = JSON.parse(raw) as Actor;
    // Expired locally is expired, so the UI never offers an identity the
    // database is about to refuse.
    if (!actor.token || actor.expiresAt <= Date.now()) {
      write(ACTOR_KEY, null);
      return null;
    }
    return actor;
  } catch {
    write(ACTOR_KEY, null);
    return null;
  }
}

export function clearActor() {
  write(ACTOR_KEY, null);
}

export type PinResult =
  | { ok: true; actor: Actor }
  | { ok: false; reason: "wrong_pin"; attemptsLeft: number }
  | { ok: false; reason: "locked"; until: string }
  | { ok: false; reason: "no_pin" }
  | { ok: false; reason: "error"; message: string };

/**
 * "I'm Desmond" — a four-digit PIN against an enrolled device.
 *
 * The database decides. It counts failures, locks the profile after too many,
 * and keeps counting even when the answer is wrong, which is why this returns
 * a result rather than throwing: a wrong PIN is an ordinary outcome of a
 * child typing on a tablet, not an exception.
 */
export async function signInWithPin(
  member: { id: string; display_name: string },
  pin: string,
): Promise<PinResult> {
  const deviceId = getDeviceId();
  if (!deviceId) {
    return {
      ok: false,
      reason: "error",
      message: "This device has not been set up yet. A parent can do it in Settings.",
    };
  }

  const { data, error } = await getSupabaseClient().rpc("verify_member_pin", {
    p_member_id: member.id,
    p_pin: pin,
    p_device_id: deviceId,
  });

  if (error) {
    if (/no PIN has been set/i.test(error.message)) return { ok: false, reason: "no_pin" };
    return { ok: false, reason: "error", message: error.message };
  }

  const result = data as
    | { ok: true; token: string }
    | { ok: false; reason: "wrong_pin"; attempts_left: number }
    | { ok: false; reason: "locked"; locked_until: string };

  if (!result.ok) {
    return result.reason === "locked"
      ? { ok: false, reason: "locked", until: result.locked_until }
      : { ok: false, reason: "wrong_pin", attemptsLeft: result.attempts_left };
  }

  const actor: Actor = {
    memberId: member.id,
    displayName: member.display_name,
    token: result.token,
    // Shorter than the database's own lifetime on purpose: the UI should ask
    // again before the backend starts refusing mid-tap.
    expiresAt: Date.now() + 1000 * 60 * 60 * 3,
  };
  write(ACTOR_KEY, JSON.stringify(actor));
  return { ok: true, actor };
}
