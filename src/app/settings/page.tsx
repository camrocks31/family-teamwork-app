"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/auth-gate";
import { getSupabaseClient } from "@/lib/supabase/client";
import { enrollThisDevice, forgetThisDevice, getDeviceId } from "@/lib/kiosk";
import { SettingsRooms, type Space } from "@/components/settings-rooms";
import { SettingsTasks } from "@/components/settings-tasks";

/**
 * Settings — the parent's side of the hub.
 *
 * This first pass covers the two things without which the children cannot use
 * the app at all: enrolling the tablet, and giving each child a PIN. Rooms,
 * tasks and rewards follow; they are editable data by design and none of this
 * is hard-coded, but the screens for them are not written yet and saying so
 * is better than a page that pretends.
 *
 * Everything here is parent-only, and that is enforced in the database: each
 * function re-checks app_is_parent() and the caller's household. Hiding these
 * controls from a child's view is tidiness, not security.
 */

interface Member {
  id: string;
  display_name: string;
  role: "parent" | "child";
  avatar_emoji: string | null;
  has_pin: boolean;
}

interface Device {
  id: string;
  label: string;
  status: string;
  enrolled_at: string;
  active_profiles: number;
}

export default function SettingsPage() {
  return (
    <AuthGate>
      <Settings />
    </AuthGate>
  );
}

function Settings() {
  const [members, setMembers] = useState<Member[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);

  const load = useCallback(async () => {
    const supabase = getSupabaseClient();

    const { data: people, error: peopleError } = await supabase
      .from("family_members")
      .select("id, display_name, role, avatar_emoji")
      .eq("is_active", true)
      .order("role")
      .order("display_name");
    if (peopleError) throw new Error(peopleError.message);

    // member_credentials is readable by no client role at all, by design, so
    // "has a PIN" cannot be read directly. It is not worth widening that for
    // a tick in a list: setting a PIN again is harmless and is the only
    // action here anyway.
    setMembers(
      (people ?? []).map((m) => ({ ...(m as Omit<Member, "has_pin">), has_pin: false })),
    );

    const { data: deviceRows, error: deviceError } = await supabase.rpc("list_devices");
    if (deviceError) throw new Error(deviceError.message);
    setDevices((deviceRows as Device[]) ?? []);

    const { data: household } = await supabase.from("households").select("id").maybeSingle();
    if (household) setHouseholdId(household.id);

    const { data: spaceRows, error: spaceError } = await supabase
      .from("household_spaces")
      .select("id, parent_space_id, name, icon, display_order, is_active")
      .order("display_order")
      .order("name");
    if (spaceError) throw new Error(spaceError.message);
    setSpaces((spaceRows as Space[]) ?? []);
  }, []);

  useEffect(() => {
    // Which tablet this is lives in localStorage, invisible to a prerendered
    // page, so it has to be read after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThisDevice(getDeviceId());
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      setNote(what);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const children = members.filter((m) => m.role === "child");

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-6">
      <Link
        href="/"
        className="inline-flex min-h-[44px] items-center gap-2 text-sm font-medium text-accent"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        The house
      </Link>

      <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight">
        Settings
      </h1>

      {error && (
        <p role="alert" className="mt-4 rounded-[var(--radius-card)] border border-attention-line bg-attention-wash px-4 py-3 text-attention-ink">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="mt-4 rounded-[var(--radius-card)] border border-line bg-done-wash px-4 py-3">
          {note}
        </p>
      )}

      {/* ---- This tablet ---- */}
      <section className="mt-8">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          This tablet
        </h2>
        <p className="mt-1 text-sm text-muted">
          A tablet has to be set up once before anyone can sign in on it with a
          PIN. Do this on the device itself, not on your laptop.
        </p>

        {thisDevice ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
            <p className="font-semibold">This tablet is set up.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                forgetThisDevice();
                setThisDevice(null);
                setNote("This tablet will ask to be set up again.");
              }}
              className="ml-auto min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
            >
              Forget it here
            </button>
          </div>
        ) : (
          <EnrollForm
            busy={busy}
            onEnroll={(label) =>
              run("This tablet is set up. Children can sign in with their PIN now.", async () => {
                const id = await enrollThisDevice(label);
                setThisDevice(id);
              })
            }
          />
        )}
      </section>

      {/* ---- PINs ---- */}
      <section className="mt-10">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          PINs
        </h2>
        <p className="mt-1 text-sm text-muted">
          Four digits each. A PIN says who pressed done — it never gives a child
          a parent&rsquo;s permissions, on any device.
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {children.map((child) => (
            <li key={child.id}>
              <PinForm
                member={child}
                busy={busy}
                onSet={(pin) =>
                  run(`${child.display_name}'s PIN is set.`, async () => {
                    const { error: pinError } = await getSupabaseClient().rpc(
                      "set_member_pin",
                      { p_member_id: child.id, p_pin: pin },
                    );
                    if (pinError) throw new Error(pinError.message);
                  })
                }
              />
            </li>
          ))}
          {children.length === 0 && <li className="text-muted">No children yet.</li>}
        </ul>
      </section>

      {/* ---- Devices ---- */}
      <section className="mt-10">
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
          Tablets and phones
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {devices.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4"
            >
              <div>
                <p className="font-semibold">{d.label}</p>
                <p className="text-sm text-muted">
                  {d.status === "active" ? "Active" : "Removed"}
                  {d.active_profiles > 0 && ` · ${d.active_profiles} signed in`}
                  {d.id === thisDevice && " · this one"}
                </p>
              </div>
              {d.status === "active" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(`${d.label} was removed and everyone on it signed out.`, async () => {
                      const { error: revokeError } = await getSupabaseClient().rpc(
                        "revoke_device",
                        { p_device_id: d.id },
                      );
                      if (revokeError) throw new Error(revokeError.message);
                      if (d.id === thisDevice) {
                        forgetThisDevice();
                        setThisDevice(null);
                      }
                    })
                  }
                  className="ml-auto min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
          {devices.length === 0 && (
            <li className="text-muted">No tablets set up yet.</li>
          )}
        </ul>
      </section>

      {householdId && (
        <SettingsRooms
          householdId={householdId}
          onError={setError}
          onNote={(m) => {
            setNote(m);
            void load();
          }}
        />
      )}

      <SettingsTasks
        spaces={spaces}
        members={members}
        onError={setError}
        onNote={(m) => {
          setNote(m);
          void load();
        }}
      />

      <section className="mt-10 rounded-[var(--radius-card)] border border-line bg-surface p-4">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">
          Not here yet
        </h2>
        <p className="mt-1 text-sm text-muted">
          Rewards, Lucy&rsquo;s own page, shopping and the calendar.
        </p>
      </section>

    </main>
  );
}

function EnrollForm({
  busy,
  onEnroll,
}: {
  busy: boolean;
  onEnroll: (label: string) => void;
}) {
  const [label, setLabel] = useState("Kitchen iPad");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onEnroll(label);
      }}
      className="mt-3 flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4"
    >
      <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
        <label htmlFor="device-label" className="text-sm font-semibold">
          What should this tablet be called?
        </label>
        <input
          id="device-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          className="min-h-[48px] rounded-xl border border-line bg-ground px-3 text-base outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="min-h-[48px] rounded-2xl bg-accent px-5 font-[family-name:var(--font-display)] font-semibold text-white disabled:opacity-60"
      >
        Set up this tablet
      </button>
    </form>
  );
}

function PinForm({
  member,
  busy,
  onSet,
}: {
  member: Member;
  busy: boolean;
  onSet: (pin: string) => void;
}) {
  const [pin, setPin] = useState("");
  const valid = /^\d{4}$/.test(pin);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onSet(pin);
          setPin("");
        }
      }}
      className="flex flex-wrap items-end gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4"
    >
      <p className="flex items-center gap-2 font-[family-name:var(--font-display)] text-lg font-semibold">
        <span aria-hidden="true">{member.avatar_emoji ?? "🙂"}</span>
        {member.display_name}
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`pin-${member.id}`} className="text-sm font-semibold">
          New PIN
        </label>
        <input
          id={`pin-${member.id}`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="0000"
          className="min-h-[48px] w-28 rounded-xl border border-line bg-ground px-3 text-center font-[family-name:var(--font-display)] text-xl tracking-[0.4em] outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-line"
        />
      </div>
      <button
        type="submit"
        disabled={busy || !valid}
        className="ml-auto min-h-[48px] rounded-2xl bg-accent px-5 font-[family-name:var(--font-display)] font-semibold text-white disabled:opacity-60"
      >
        Set PIN
      </button>
    </form>
  );
}
