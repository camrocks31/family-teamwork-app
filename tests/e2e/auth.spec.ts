import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1539 acceptance criterion 10.
 *
 * A seeded parent signs in, sees the guarded shell, signs out and is returned
 * to sign-in; the session survives a reload.
 */

const EMAIL = "e2e-parent@example.test";
const PASSWORD = "e2e-correct-horse-battery-staple";

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "The e2e suite needs NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in .env.local (local stack only).",
    );
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Link the e2e account to a seeded parent, idempotently, so the suite can be
  // re-run without a db reset in between.
  const { data: member } = await admin
    .from("family_members")
    .select("id, auth_user_id")
    .eq("display_name", "Parent Two")
    .single();
  if (!member) throw new Error("Seed is missing — run `npm run db:reset`.");

  if (!member.auth_user_id) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error && !/already/i.test(error.message)) throw error;

    let userId: string | undefined = created?.user?.id;
    if (!userId) {
      const { data: list } = await admin.auth.admin.listUsers();
      userId = list.users.find((u) => u.email === EMAIL)?.id;
    }
    if (!userId) throw new Error("Could not create or find the e2e account.");

    await admin
      .from("family_members")
      .update({ auth_user_id: userId })
      .eq("id", member.id);
  }
});

test("a parent signs in, stays signed in across a reload, and signs out", async ({
  page,
}) => {
  await page.goto("/");

  // The gate shows sign-in, and no household data, before authentication.
  await expect(page.getByRole("heading", { name: "Our Family Hub" })).toBeVisible();
  await expect(page.getByText("Example Household")).toHaveCount(0);

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The guarded shell loads the household through RLS.
  await expect(page.getByRole("heading", { name: "Example Household" })).toBeVisible();
  await expect(page.getByText("Parent One")).toBeVisible();

  // The session survives a reload: a static export has no server to hold it,
  // so this is really a check that the browser session persists.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Example Household" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Example Household")).toHaveCount(0);
});

test("a wrong password does not reveal whether the account exists", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Scoped to the page's own content: Next renders a route announcer with
  // role="alert" outside <main>, which would otherwise match too.
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeVisible();
  // The app is on a public URL; a "no such account" message would let anyone
  // enumerate which email addresses have accounts here.
  await expect(alert).toHaveText(/did not match/i);
  await expect(alert).not.toHaveText(/not found|no account|unknown/i);
});
