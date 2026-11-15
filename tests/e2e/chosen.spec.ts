import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1549 — the journey where a child picks their own job.
 *
 * The database tests prove the engine refuses what it should. This proves the
 * thing the slice actually exists for: that a child opens their page, is told
 * in plain words how many of the spare jobs are theirs to choose, reads WHY a
 * job exists, takes one, and finds it still theirs after the page reloads.
 *
 * Run against the built static export, not the dev server: the dev server
 * does not hydrate over 127.0.0.1 here, and React's double mount in strict
 * mode leaves the auth gate stuck on "Loading…".
 */

const EMAIL = "e2e-chosen@example.test";
const PASSWORD = "e2e-chosen-password";
const PIN = "9517";
// One stamp for the whole run, so teardown finds everything this file made.
const RUN = Date.now();
const LABEL = `Chosen iPad ${RUN}`;
const SPARE_TITLE = `Sweep the porch ${RUN}`;
const SPARE_REASON = "The porch is where everyone drops their bags, so it goes bad fast.";

let admin: SupabaseClient;
let householdId: string;
let childId: string;
let childName: string;
let originalMinimum = 0;

/** How many open jobs this child already holds, whatever other suites left. */
async function heldOpenCount(): Promise<number> {
  const { data } = await admin
    .from("task_assignments")
    .select("definition_id, task_definitions!inner(assignment_mode, is_active)")
    .eq("member_id", childId);
  return (data ?? []).filter((r) => {
    const d = r.task_definitions as unknown as { assignment_mode: string; is_active: boolean };
    return d.assignment_mode === "open" && d.is_active;
  }).length;
}

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("The e2e suite needs the local keys in .env.local.");
  admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: parent } = await admin
    .from("family_members")
    .select("id, household_id")
    .eq("display_name", "Parent One")
    .single();
  if (!parent) throw new Error("Seed is missing — run `npm run db:reset`.");
  householdId = parent.household_id;

  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error && !/already|registered|exists/i.test(error.message)) throw error;
  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === EMAIL)?.id;
  }
  await admin.from("family_members").update({ auth_user_id: null }).eq("auth_user_id", userId!);
  await admin.from("family_members").update({ auth_user_id: userId! }).eq("id", parent.id);

  const { data: child } = await admin
    .from("family_members")
    .select("id, display_name, min_chosen_jobs")
    .eq("household_id", householdId)
    .eq("role", "child")
    .limit(1)
    .single();
  childId = child!.id;
  childName = child!.display_name;
  originalMinimum = child!.min_chosen_jobs ?? 0;

  // A job going spare, created through the tables because save_task needs a
  // parent's own session and this runs as the service role.
  const { data: def } = await admin
    .from("task_definitions")
    .insert({
      household_id: householdId,
      occurrence_mode: "per_member",
      assignment_mode: "open",
    })
    .select("id")
    .single();
  const { data: rev } = await admin
    .from("task_definition_revisions")
    .insert({
      definition_id: def!.id,
      household_id: householdId,
      revision_number: 1,
      title: SPARE_TITLE,
      recurrence: "daily",
      occurrence_mode: "per_member",
      reason: SPARE_REASON,
    })
    .select("id")
    .single();
  await admin.from("task_definition_criteria").insert({
    revision_id: rev!.id,
    household_id: householdId,
    display_order: 1,
    text: "Front step and the mat",
  });
  await admin
    .from("task_definitions")
    .update({ current_revision_id: rev!.id })
    .eq("id", def!.id);
});

/**
 * Put the house back. Best-effort: a cleanup failure must not fail a suite
 * that has already proved what it set out to prove, and the order matters
 * because the task tables reference each other with RESTRICT.
 */
test.afterAll(async () => {
  try {
    await admin
      .from("family_members")
      .update({ min_chosen_jobs: originalMinimum, simple_view: false })
      .eq("id", childId);

    const { data: defs } = await admin
      .from("task_definition_revisions")
      .select("definition_id")
      .like("title", `%${RUN}`);
    const ids = [...new Set((defs ?? []).map((d) => d.definition_id))];
    if (ids.length > 0) {
      const { data: insts } = await admin
        .from("task_instances")
        .select("id")
        .in("definition_id", ids);
      const instIds = (insts ?? []).map((i) => i.id);
      if (instIds.length > 0) {
        await admin.from("task_events").delete().in("task_instance_id", instIds);
        await admin.from("task_operations").delete().in("task_instance_id", instIds);
        await admin.from("task_photos").delete().in("task_instance_id", instIds);
        await admin.from("task_instances").delete().in("id", instIds);
      }
      await admin.from("task_assignments").delete().in("definition_id", ids);
      const { data: revs } = await admin
        .from("task_definition_revisions")
        .select("id")
        .in("definition_id", ids);
      for (const r of revs ?? []) {
        await admin.from("task_definition_criteria").delete().eq("revision_id", r.id);
      }
      await admin.from("task_definitions").update({ current_revision_id: null }).in("id", ids);
      await admin.from("task_definition_revisions").delete().in("definition_id", ids);
      await admin.from("task_definitions").delete().in("id", ids);
    }
  } catch {
    // Reported by the next run's fixtures if it matters.
  }
});

/** Parent signs in, sets this tablet up, and gives the child a PIN. */
async function setUpTabletAndPin(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("What should this tablet be called?").fill(LABEL);
  await page.getByRole("button", { name: "Set up this tablet" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(/set up/i);

  await page.getByLabel("New PIN", { exact: false }).first().fill(PIN);
  await page.getByRole("button", { name: "Set PIN" }).first().click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(/PIN is set/i);
}

/** The child taps their face and types the PIN, landing on their own jobs. */
async function signInAsChild(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(childName) }).click();
  for (const d of PIN) await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByRole("heading", { name: `${childName}’s jobs` })).toBeVisible();
}

test("a child is told how many are theirs to choose, reads why, and takes one", async ({
  page,
}) => {
  // The wording counts a shortfall against everything already held, so the
  // expectation is built from a baseline rather than assuming zero.
  const baseline = await heldOpenCount();
  await admin
    .from("family_members")
    .update({ min_chosen_jobs: baseline + 2, simple_view: false })
    .eq("id", childId);

  await setUpTabletAndPin(page);
  await signInAsChild(page);

  const section = page.locator("section", { hasText: "Jobs you pick yourself" }).first();

  // AC15 — it says how many are wanted, in words, and lists what is going spare.
  await expect(section).toContainText(`${baseline + 2} of these are yours to choose`);
  await expect(section).toContainText("2 to go");
  await expect(section).toContainText(SPARE_TITLE);
  // AC17 — and WHY the job exists, which is the whole point of the reason.
  await expect(section).toContainText(SPARE_REASON);

  const spare = page.locator("li", { hasText: SPARE_TITLE }).first();
  await spare.getByRole("button", { name: /take this one/i }).click();

  // AC15 — after taking one, one fewer is wanted.
  await expect(section).toContainText("1 to go", { timeout: 15_000 });
  await expect(section).toContainText("Yours");
  await expect(section.getByRole("button", { name: /give it back/i })).toBeVisible();

  // It is a real row, not a note in the browser.
  const { data: held } = await admin
    .from("task_assignments")
    .select("member_id, definition_id")
    .eq("member_id", childId);
  const { data: mine } = await admin
    .from("task_definition_revisions")
    .select("definition_id")
    .eq("title", SPARE_TITLE)
    .single();
  expect((held ?? []).some((h) => h.definition_id === mine!.definition_id)).toBe(true);

  // AC17, the other half. The reason must also be on the JOB itself once it
  // is one of today's, in the ordinary list view — not only on the card that
  // offered it. An earlier version of this test asserted the offer and called
  // the criterion met.
  const mineList = page.locator("section", { hasText: "Just yours" }).first();
  await expect(mineList).toContainText(SPARE_TITLE, { timeout: 15_000 });
  await expect(mineList).toContainText(SPARE_REASON);

  // AC16 — still theirs after a full reload.
  await page.reload();
  await expect(page.getByRole("heading", { name: `${childName}’s jobs` })).toBeVisible();
  await expect(
    page.locator("section", { hasText: "Jobs you pick yourself" }).first(),
  ).toContainText("1 to go");
});

test("the reason is on screen in the one-job-at-a-time view too (AC17)", async ({ page }) => {
  await admin
    .from("family_members")
    .update({ min_chosen_jobs: 0, simple_view: true })
    .eq("id", childId);

  await setUpTabletAndPin(page);
  await signInAsChild(page);

  // Take the spare job, so it becomes one of today's.
  const section = page.locator("section", { hasText: "Jobs you pick yourself" }).first();
  const take = page.locator("li", { hasText: SPARE_TITLE }).first().getByRole("button", {
    name: /take this one/i,
  });
  if (await take.isVisible()) {
    await take.click();
    await expect(section).toContainText("Yours", { timeout: 15_000 });
  }

  // The one-at-a-time view shows exactly ONE job, chosen by title order, so
  // the fixture job is only guaranteed to be in front once everything ahead of
  // it is out of the way. Parked rather than deleted, and put back below.
  const { data: mine } = await admin
    .from("task_definition_revisions")
    .select("definition_id")
    .eq("title", SPARE_TITLE)
    .single();

  const { data: ahead } = await admin
    .from("task_instances")
    .select("id")
    .eq("occurrence_date", await householdToday())
    .neq("definition_id", mine!.definition_id)
    .in("state", ["pending", "in_progress", "submitted", "needs_attention"]);
  const parked = (ahead ?? []).map((r) => r.id);

  try {
    if (parked.length > 0) {
      const { error } = await admin
        .from("task_instances")
        .update({ state: "completed", completed_by: childId, completed_at: new Date().toISOString() })
        .in("id", parked);
      if (error) throw new Error(`could not park the other jobs: ${error.message}`);
    }

    await page.reload();
    await expect(page.getByRole("heading", { name: `${childName}’s jobs` })).toBeVisible();

    // Now the only outstanding job is ours, so the single card in front is it
    // — and the reason must be under the title, not hidden behind it.
    const card = page.locator("section", { hasText: /One more thing|Next of/ }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole("heading", { name: SPARE_TITLE })).toBeVisible();
    await expect(card).toContainText(SPARE_REASON);
    await expect(card.getByRole("button", { name: "I did it" })).toBeVisible();
  } finally {
    if (parked.length > 0) {
      await admin
        .from("task_instances")
        .update({
          state: "pending",
          completed_by: null,
          completed_at: null,
          submitted_by: null,
          submitted_at: null,
        })
        .in("id", parked);
    }
  }
});

/** Today, in the household's own timezone — never the test runner's. */
async function householdToday(): Promise<string> {
  const { data } = await admin
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .single();
  return new Intl.DateTimeFormat("en-CA", { timeZone: data!.timezone }).format(new Date());
}
