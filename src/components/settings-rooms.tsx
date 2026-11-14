"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";

/**
 * Rooms, editable.
 *
 * The brief is explicit that rooms are seed data a family edits, never
 * hard-coded logic — this is the screen that makes that true. Row level
 * security already allows a parent to write household_spaces directly, so
 * there is no function in front of it: the policy requires the household to
 * match and the caller to be a parent, and those are the only rules.
 *
 * Removing a room DEACTIVATES it rather than deleting it. A room's tasks
 * carry dated history, and a household that rearranges its bedrooms should
 * not lose last month's record of who tidied what. An inactive room stops
 * appearing on the dashboard, and its tasks stop being created, because both
 * already filter on is_active.
 */

export interface Space {
  id: string;
  parent_space_id: string | null;
  name: string;
  icon: string | null;
  display_order: number;
  is_active: boolean;
}

export function SettingsRooms({
  householdId,
  onError,
  onNote,
}: {
  householdId: string;
  onError: (message: string | null) => void;
  onNote: (message: string) => void;
}) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [busy, setBusy] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await getSupabaseClient()
      .from("household_spaces")
      .select("id, parent_space_id, name, icon, display_order, is_active")
      .order("display_order")
      .order("name");
    if (error) throw new Error(error.message);
    setSpaces((data as Space[]) ?? []);
  }, []);

  useEffect(() => {
    // Fetching on mount, which is what an effect is for. The rule traces
    // into load() and sees the setState there; there is no earlier moment
    // to know this data, and the alternative is hiding the same call
    // inside an IIFE to defeat the check rather than satisfy it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch((e) => onError(e instanceof Error ? e.message : String(e)));
    // onError is a prop callback; depending on it would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function run(note: string, fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await load();
      onNote(note);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const floors = spaces.filter((s) => s.parent_space_id === null);
  const roomsOf = (floorId: string) => spaces.filter((s) => s.parent_space_id === floorId);

  return (
    <section className="mt-10">
      <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
        Rooms
      </h2>
      <p className="mt-1 text-sm text-muted">
        Removing a room hides it and stops its jobs. Nothing already recorded
        is lost.
      </p>

      <div className="mt-4 flex flex-col gap-6">
        {floors.map((floor) => (
          <div key={floor.id}>
            <SpaceRow
              space={floor}
              busy={busy}
              onRename={(name) =>
                run(`Renamed to ${name}.`, async () => {
                  const { error } = await getSupabaseClient()
                    .from("household_spaces")
                    .update({ name })
                    .eq("id", floor.id);
                  if (error) throw new Error(error.message);
                })
              }
              onToggle={() =>
                run(floor.is_active ? `${floor.name} hidden.` : `${floor.name} is back.`, async () => {
                  const { error } = await getSupabaseClient()
                    .from("household_spaces")
                    .update({ is_active: !floor.is_active })
                    .eq("id", floor.id);
                  if (error) throw new Error(error.message);
                })
              }
              heading
            />

            <ul className="mt-2 flex flex-col gap-2 pl-4">
              {roomsOf(floor.id).map((room) => (
                <li key={room.id}>
                  <SpaceRow
                    space={room}
                    busy={busy}
                    onRename={(name) =>
                      run(`Renamed to ${name}.`, async () => {
                        const { error } = await getSupabaseClient()
                          .from("household_spaces")
                          .update({ name })
                          .eq("id", room.id);
                        if (error) throw new Error(error.message);
                      })
                    }
                    onToggle={() =>
                      run(
                        room.is_active ? `${room.name} hidden.` : `${room.name} is back.`,
                        async () => {
                          const { error } = await getSupabaseClient()
                            .from("household_spaces")
                            .update({ is_active: !room.is_active })
                            .eq("id", room.id);
                          if (error) throw new Error(error.message);
                        },
                      )
                    }
                  />
                </li>
              ))}
            </ul>

            {addingTo === floor.id ? (
              <AddSpace
                busy={busy}
                onCancel={() => setAddingTo(null)}
                onAdd={(name, icon) =>
                  run(`${name} added.`, async () => {
                    const { error } = await getSupabaseClient()
                      .from("household_spaces")
                      .insert({
                        household_id: householdId,
                        parent_space_id: floor.id,
                        name,
                        icon: icon || null,
                        display_order: roomsOf(floor.id).length + 1,
                      });
                    if (error) throw new Error(error.message);
                    setAddingTo(null);
                  })
                }
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddingTo(floor.id)}
                className="mt-2 ml-4 min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
              >
                Add a room to {floor.name}
              </button>
            )}
          </div>
        ))}
        {floors.length === 0 && <p className="text-muted">No floors yet.</p>}
      </div>
    </section>
  );
}

function SpaceRow({
  space,
  busy,
  onRename,
  onToggle,
  heading,
}: {
  space: Space;
  busy: boolean;
  onRename: (name: string) => void;
  onToggle: () => void;
  heading?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(space.name);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) {
            onRename(name.trim());
            setEditing(false);
          }
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <label className="sr-only" htmlFor={`name-${space.id}`}>
          Name for {space.name}
        </label>
        <input
          id={`name-${space.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-h-[44px] flex-1 rounded-xl border border-line bg-ground px-3"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-[44px] rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-60"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setName(space.name);
            setEditing(false);
          }}
          className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p
        className={
          heading
            ? "font-[family-name:var(--font-display)] text-lg font-semibold"
            : "font-medium"
        }
      >
        {space.icon && <span aria-hidden="true">{space.icon} </span>}
        {space.name}
        {!space.is_active && <span className="ml-2 text-sm text-muted">hidden</span>}
      </p>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="ml-auto min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
      >
        Rename
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onToggle}
        className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold disabled:opacity-60"
      >
        {space.is_active ? "Remove" : "Put back"}
      </button>
    </div>
  );
}

function AddSpace({
  busy,
  onAdd,
  onCancel,
}: {
  busy: boolean;
  onAdd: (name: string, icon: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onAdd(name.trim(), icon.trim());
      }}
      className="mt-2 ml-4 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="new-room" className="text-sm font-semibold">
          Room name
        </label>
        <input
          id="new-room"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="min-h-[44px] rounded-xl border border-line bg-ground px-3"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="new-room-icon" className="text-sm font-semibold">
          Icon
        </label>
        <input
          id="new-room-icon"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          maxLength={4}
          placeholder="🛏"
          className="min-h-[44px] w-20 rounded-xl border border-line bg-ground px-3 text-center"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="min-h-[44px] rounded-xl bg-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
      >
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="min-h-[44px] rounded-xl border border-line px-3 text-sm font-semibold"
      >
        Cancel
      </button>
    </form>
  );
}
