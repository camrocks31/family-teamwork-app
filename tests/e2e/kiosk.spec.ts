import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1545 — the journey a child actually takes.
 *
 * Until this existed the app had no way for anyone to say who they were, and
 * no way to tick anything off: the whole thing was a readout. This walks the
 * real path, in a browser, against the built export — parent sets up the
 * tablet and a PIN, child taps their face, types four digits, and marks a job
 * done — and then checks the database recorded it as the CHILD'S work, not
 * the parent's, which is the entire reason kiosk identity exists.
 */

const EMAIL = "e2e-kiosk@example.test";
const PASSWORD = "e2e-kiosk-password";
const PIN = "2468";
// Unique per run. The database suite leaves its own devices behind and
// they cannot simply be deleted — member_sessions references them with
// RESTRICT — so this test identifies its own rather than assuming it is
// the only one. The first version deleted blindly, did not check the
// error, and then asserted the table held exactly one row.
const LABEL = `Test iPad ${Date.now()}`;

let admin: SupabaseClient;
let householdId: string;
let childName: string;
let childId: string;
let today: string;

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
  // Claim the parent unconditionally: other suites link their own accounts to
  // the same seeded people.
  await admin.from("family_members").update({ auth_user_id: null }).eq("auth_user_id", userId!);
  await admin.from("family_members").update({ auth_user_id: userId! }).eq("id", parent.id);

  const { data: child } = await admin
    .from("family_members")
    .select("id, display_name")
    .eq("household_id", householdId)
    .eq("role", "child")
    .limit(1)
    .single();
  childId = child!.id;
  childName = child!.display_name;

  const { data: household } = await admin
    .from("households")
    .select("timezone")
    .eq("id", householdId)
    .single();
  today = new Intl.DateTimeFormat("en-CA", { timeZone: household!.timezone }).format(new Date());

});

test("a parent sets up the tablet and a PIN, then a child logs their own job", async ({
  page,
}) => {
  // Start from a known day. The database suite and the earlier browser tests
  // leave today's tasks in whatever state they finished in, and a test that
  // depends on that is a test that passes alone and fails in the suite.
  const { error: resetError } = await admin
    .from("task_instances")
    .update({
      state: "pending",
      completed_by: null,
      completed_at: null,
      submitted_by: null,
      submitted_at: null,
      not_applicable_reason: null,
      not_applicable_by: null,
      not_applicable_at: null,
      exemption_note: null,
      correction_note: null,
    })
    .eq("occurrence_date", today);
  if (resetError) throw new Error(`fixture reset failed: ${resetError.message}`);

  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

  // --- the parent sets the tablet up ---
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByLabel("What should this tablet be called?").fill(LABEL);
  await page.getByRole("button", { name: "Set up this tablet" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(/set up/i);

  // It is a real row, not a note in the browser.
  const { data: devices } = await admin
    .from("devices")
    .select("label, status")
    .eq("household_id", householdId)
    .eq("label", LABEL);
  expect(devices).toHaveLength(1);
  expect(devices![0]).toMatchObject({ label: LABEL, status: "active" });

  // --- and gives the child a PIN ---
  await page.getByLabel("New PIN", { exact: false }).first().fill(PIN);
  await page.getByRole("button", { name: "Set PIN" }).first().click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(/PIN is set/i);

  // --- now the child uses it ---
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(childName) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`${childName}, what is your PIN`) })).toBeVisible();

  // Scoped to <main> throughout: Next renders a route announcer with
  // role="alert" outside it, which otherwise matches every assertion.
  // A wrong PIN is refused and says so, without letting them through.
  for (const d of "1111") await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(/not the right PIN/i);

  for (const d of PIN) await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByText(`Hello, ${childName}`)).toBeVisible();

  // --- and does a job ---
  await page.getByRole("link", { name: "My jobs" }).click();
  await expect(page.getByRole("heading", { name: `${childName}’s jobs` })).toBeVisible();

  const done = page.getByRole("button", { name: "Done" }).first();
  await expect(done).toBeVisible();
  await done.click();

  // The database recorded it as the CHILD'S work. A parent's session was the
  // only thing signed in, so without the actor token this would be the
  // parent — which is exactly the bug kiosk identity exists to prevent.
  await expect
    .poll(
      async () => {
        const { count } = await admin
          .from("task_instances")
          .select("id", { count: "exact", head: true })
          .eq("occurrence_date", today)
          .eq("state", "completed")
          .eq("completed_by", childId);
        return count ?? 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

test("a child cannot sign in on a tablet that was never set up", async ({ page }) => {
  // Nothing is deleted: "not set up" is a property of THIS BROWSER, which has
  // no device id, not of the household's device list.
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

  // The browser may still remember a device id from the previous test; the
  // point is that the DATABASE refuses it, not that the UI hides the button.
  await page.evaluate(() => window.localStorage.removeItem("ofh.device_id"));
  await page.reload();

  const tile = page.getByRole("button", { name: new RegExp(childName) });
  await expect(tile).toBeDisabled();
  await expect(page.getByText(/has not been set up yet/i)).toBeVisible();
});

test("a parent adds a room and a job, and the job appears for the family", async ({
  page,
}) => {
  // The brief's standing requirement: rooms, tasks and their criteria are
  // editable data, never hard-coded. Until this screen existed they were
  // editable in principle — by writing SQL.
  const room = `Utility Room ${Date.now()}`;
  const job = `Sweep the floor ${Date.now()}`;

  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Settings" }).click();

  // --- a new room ---
  await page.getByRole("button", { name: /Add a room to Downstairs/ }).click();
  await page.getByLabel("Room name").fill(room);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  // exact, because the confirmation message also contains the name.
  await expect(page.getByText(room, { exact: true })).toBeVisible();

  // --- a new job in it, with real criteria ---
  await page.getByRole("button", { name: "Add a job" }).click();
  await page.getByLabel("What is the job called?").fill(job);
  await page.getByRole("textbox", { name: "Thing to check 1" }).fill("Floor swept");
  await page.getByRole("button", { name: "Add another" }).click();
  await page.getByRole("textbox", { name: "Thing to check 2" }).fill("Bin emptied");
  await page.getByLabel("Which room?").selectOption({ label: room });
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("main").getByRole("status")).toContainText(/added/i);
  await expect(page.getByText(job, { exact: true })).toBeVisible();
  await expect(page.getByText(/2 things to check/).first()).toBeVisible();

  // It is a real definition with a real revision and real criteria.
  const { data: saved } = await admin
    .from("task_definition_revisions")
    .select("title, revision_number")
    .eq("title", job)
    .single();
  expect(saved).toMatchObject({ title: job, revision_number: 1 });

  // --- editing it writes a second revision, leaving the first alone ---
  await page
    .getByRole("listitem")
    .filter({ hasText: job })
    .getByRole("button", { name: "Edit" })
    .click();
  await page.getByLabel("What is the job called?").fill(`${job} (tidied up)`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText(/saved/i);

  const { data: revisions } = await admin
    .from("task_definition_revisions")
    .select("title, revision_number")
    .in("title", [job, `${job} (tidied up)`])
    .order("revision_number");
  expect(revisions!.map((r) => r.revision_number)).toEqual([1, 2]);
  // The original wording still exists, which is the whole point.
  expect(revisions![0].title).toBe(job);
});
