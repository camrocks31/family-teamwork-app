import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1544 — the dashboard in a real browser, against the built export.
 *
 * The test that matters here is the live one. The brief's first acceptance
 * scenario is a child finishing something in one room and the iPad on the
 * wall changing by itself; a dashboard that needs a pull-to-refresh is a
 * different, worse product.
 */

const EMAIL = "e2e-dashboard@example.test";
const PASSWORD = "e2e-dashboard-password";

let admin: SupabaseClient;
let householdId: string;
let today: string;

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("The e2e suite needs the local Supabase keys in .env.local.");
  }
  admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Link unconditionally — the database suites run first in CI and claim the
  // seeded parents for their own accounts.
  const { data: member } = await admin
    .from("family_members")
    .select("id, household_id")
    .eq("display_name", "Parent One")
    .single();
  if (!member) throw new Error("Seed is missing — run `npm run db:reset`.");
  householdId = member.household_id;

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
  await admin.from("family_members").update({ auth_user_id: userId! }).eq("id", member.id);

  const { data: household } = await admin
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .single();
  today = new Intl.DateTimeFormat("en-CA", { timeZone: household!.timezone }).format(new Date());

  // A day's work to look at, all of it outstanding.
  //
  // Materialization runs as the SIGNED-IN PARENT, not the service role: the
  // function derives the household from the session and refuses a caller
  // that has none. The first version called it with the admin client and
  // ignored the error, so no tasks were ever created and the dashboard
  // honestly reported "0 of 0 jobs done" — which then looked like a broken
  // dashboard rather than a broken fixture. Every error here is checked now.
  const asParent = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error: signInError } = await asParent.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  if (signInError) throw new Error(`fixture sign-in failed: ${signInError.message}`);

  const { error: materializeError } = await asParent.rpc("ensure_day_materialized", {
    p_household_id: householdId,
    p_local_date: today,
  });
  if (materializeError) {
    throw new Error(`fixture materialization failed: ${materializeError.message}`);
  }

  const { error: resetError } = await admin
    .from("task_instances")
    .update({
      state: "pending",
      completed_by: null,
      completed_at: null,
      submitted_by: null,
      submitted_at: null,
      // The not-applicable columns have to be cleared too. A row left
      // "pending" with an exemption reason still attached violates the check
      // that those fields exist only while the task is not applicable — which
      // is the constraint doing exactly its job on a careless fixture.
      not_applicable_reason: null,
      not_applicable_by: null,
      not_applicable_at: null,
      exemption_note: null,
      correction_note: null,
    })
    .eq("occurrence_date", today);
  if (resetError) throw new Error(`fixture reset failed: ${resetError.message}`);

  const { count, error: countError } = await admin
    .from("task_instances")
    .select("id", { count: "exact", head: true })
    .eq("occurrence_date", today);
  if (countError) throw new Error(countError.message);
  // Assert the fixture actually exists, so a silent setup failure cannot
  // masquerade as a product defect again.
  if (!count) throw new Error("fixture produced no task instances");
});

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

test("a parent sees the household: people, rooms, activities, the pet and shopping", async ({
  page,
}) => {
  await signIn(page);

  await expect(page.getByRole("heading", { name: "The house", exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Play Video Games" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Watch TV" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dog" })).toBeVisible();
  await expect(page.getByText("Children's Bedroom")).toBeVisible();

  // Both adult-shared rooms are shown — they have their own tasks — even
  // though neither gates the children's activities.
  await expect(page.getByText("Adult Bedroom")).toBeVisible();
  await expect(page.getByText("Shared Bedroom")).toBeVisible();
});

test("every status is written out, not just coloured", async ({ page }) => {
  await signIn(page);
  // Colour alone would fail a seven-year-old and anyone colour-blind reading
  // it from across the kitchen.
  await expect(page.getByText("Needs attention").first()).toBeVisible();
});

test("a blocker links through to the room it names", async ({ page }) => {
  await signIn(page);

  // Scoped to an activity card, so this follows a BLOCKER rather than a room
  // chip — the journey the brief describes is tapping "why can't I play?".
  const card = page.getByRole("region", { name: "Play Video Games" });
  const blocker = card.getByRole("link").first();
  await expect(blocker).toBeVisible();
  const blockerText = (await blocker.textContent())!;
  await blocker.click();

  await expect(page).toHaveURL(/\/house\/\?space=|\/tasks\//);

  // The room names itself and says what actually has to be done, rather than
  // repeating the task title back.
  if (/\/house\//.test(page.url())) {
    const room = blockerText.replace(/ needs attention\.?/i, "").trim();
    await expect(page.getByRole("heading", { name: room })).toBeVisible();

    // Real tasks with real criteria, not the empty state. The previous
    // version asserted only that SOME list item was visible, which is just as
    // true of "Nothing needed here today." — and it was, for the whole time
    // the room query was failing with PGRST201 and rendering nothing.
    await expect(page.getByText("Nothing needed here today.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark done" }).first()).toBeVisible();
  }
});

test("the house updates by itself when someone finishes a task elsewhere", async ({ page }) => {
  await signIn(page);

  const progress = page.getByText(/\d+ of \d+ jobs done/);
  await expect(progress).toBeVisible();
  const before = (await progress.textContent())!;
  const doneBefore = Number(before.match(/^(\d+)/)![1]);

  // Somebody finishes something in another room, on another device.
  const { data: inst } = await admin
    .from("task_instances")
    .select("id, version")
    .eq("occurrence_date", today)
    .eq("occurrence_mode", "shared")
    .eq("state", "pending")
    .limit(1)
    .single();

  const { data: parentMember } = await admin
    .from("family_members")
    .select("id")
    .eq("display_name", "Parent Two")
    .single();

  await admin
    .from("task_instances")
    .update({
      state: "completed",
      completed_by: parentMember!.id,
      completed_at: new Date().toISOString(),
      version: inst!.version + 1,
    })
    .eq("id", inst!.id);

  // No reload: the page is expected to notice.
  await expect(progress).toHaveText(new RegExp(`^${doneBefore + 1} of `), { timeout: 15_000 });
});

test("works at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("heading", { name: "Play Video Games" })).toBeVisible();
});

test("the hub creates the day itself when nobody has opened it yet", async ({ page }) => {
  // The bug this pins: ensure_day_materialized existed, was granted to the
  // client, and had a helper in src/lib/tasks.ts commented "safe to call from
  // every device, every load" — and nothing called it. The first real morning
  // showed a house of 0 of 0 jobs, a full green progress bar over a household
  // that had done nothing, and every activity reporting that its requirements
  // had "no task for today yet".
  //
  // It survived the suite because the fixture above calls
  // ensure_day_materialized before the page loads, so the TEST created the day
  // the APP was supposed to create. This test deletes the day first, so the
  // only thing that can bring it back is the application.
  // task_events and task_operations reference instances with RESTRICT, not
  // CASCADE — deliberately, since an audit row outliving nothing is the point
  // — so the day has to be dismantled in order.
  const { data: todays } = await admin
    .from("task_instances")
    .select("id")
    .eq("occurrence_date", today);
  const ids = (todays ?? []).map((r) => r.id);
  if (ids.length > 0) {
    for (const table of ["task_events", "task_operations"]) {
      const { error } = await admin.from(table).delete().in("task_instance_id", ids);
      if (error) throw new Error(`could not clear ${table}: ${error.message}`);
    }
  }
  const { error: clearError } = await admin
    .from("task_instances")
    .delete()
    .eq("occurrence_date", today);
  if (clearError) throw new Error(`could not clear the day: ${clearError.message}`);

  const { count: before } = await admin
    .from("task_instances")
    .select("id", { count: "exact", head: true })
    .eq("occurrence_date", today);
  expect(before, "the day should start empty for this test").toBe(0);

  await signIn(page);

  // The house reports real work, not an empty day dressed up as a finished one.
  const progress = page.getByText(/\d+ of \d+ jobs done/);
  await expect(progress).toBeVisible();
  const total = Number((await progress.textContent())!.match(/of (\d+)/)![1]);
  expect(total, "the dashboard should have created today's tasks").toBeGreaterThan(0);

  const { count: after } = await admin
    .from("task_instances")
    .select("id", { count: "exact", head: true })
    .eq("occurrence_date", today);
  expect(after).toBeGreaterThan(0);
});

test("each activity tile says whose it is", async ({ page }) => {
  // Three tiles that happen to agree are indistinguishable from the same list
  // printed three times, which is how this read on the wall.
  await signIn(page);
  const card = page.getByRole("region", { name: "Play Video Games" });
  await expect(card).toBeVisible();

  // Every child the activity was evaluated for is named inside the card, so
  // three tiles can never again read as one list repeated.
  const { data: children } = await admin
    .from("family_members")
    .select("display_name")
    .eq("household_id", householdId)
    .eq("role", "child");
  expect(children!.length).toBeGreaterThan(1);
  for (const child of children!) {
    await expect(
      card.getByText(child.display_name, { exact: false }).first(),
      `${child.display_name} should be named on their own tile`,
    ).toBeVisible();
  }
});

test("a task can actually be ticked off, and the house notices", async ({ page }) => {
  // Until this existed the app had no interactive controls at all: the only
  // clickable things in it were sign-in and forgot-password. Every transition
  // helper in src/lib/tasks.ts was written, tested at the database level, and
  // called by nothing.
  await signIn(page);

  // A room that genuinely has work in it today.
  const { data: room } = await admin
    .from("task_instances")
    .select(
      "task_definitions!task_instances_definition_id_fkey!inner ( location_space_id )",
    )
    .eq("occurrence_date", today)
    .eq("state", "pending")
    .not("task_definitions.location_space_id", "is", null)
    .limit(1)
    .single();
  const spaceId = (room as unknown as { task_definitions: { location_space_id: string } })
    .task_definitions.location_space_id;

  await page.goto(`/house/?space=${spaceId}`);

  // Count pending across the household, not inside the room. Scoping the
  // count to one space meant relying on the same embedded filter the page
  // uses, which is the thing under test — so a miscounted room looked like a
  // broken button.
  const pendingToday = async () => {
    const { count } = await admin
      .from("task_instances")
      .select("id", { count: "exact", head: true })
      .eq("occurrence_date", today)
      .eq("state", "pending");
    return count ?? -1;
  };
  const before = await pendingToday();
  expect(before, "there should be something pending to tick off").toBeGreaterThan(0);

  const markDone = page.getByRole("button", { name: "Mark done" }).first();
  await expect(markDone).toBeVisible();
  await markDone.click();

  // The page says so without a reload…
  await expect(page.getByText("Done").first()).toBeVisible({ timeout: 15_000 });

  // …and one task really moved out of pending. Propagation to the dashboard
  // is already covered by "the house updates by itself".
  await expect.poll(pendingToday, { timeout: 15_000 }).toBe(before - 1);
});
