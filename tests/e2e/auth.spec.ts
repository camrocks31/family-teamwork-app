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

  const { data: member } = await admin
    .from("family_members")
    .select("id")
    .eq("display_name", "Parent Two")
    .single();
  if (!member) throw new Error("Seed is missing — run `npm run db:reset`.");

  // Ensure the account exists, then link it UNCONDITIONALLY.
  //
  // This used to link only when the member had no account yet, which was
  // wrong: the database suites run first in CI and link their own test
  // accounts to the same seeded parents. The e2e then skipped its setup and
  // signed in with credentials that no longer belonged to anyone, so the
  // sign-in silently failed and the test looked like a broken dashboard.
  // Whoever the member was linked to before, after this it is us.
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error && !/already|registered|exists/i.test(error.message)) throw error;

  let userId: string | undefined = created?.user?.id;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === EMAIL)?.id;
  }
  if (!userId) throw new Error("Could not create or find the e2e account.");

  // auth_user_id is unique, so clear any other holder before claiming it.
  await admin
    .from("family_members")
    .update({ auth_user_id: null })
    .eq("auth_user_id", userId);

  const { error: linkError } = await admin
    .from("family_members")
    .update({ auth_user_id: userId })
    .eq("id", member.id);
  if (linkError) throw linkError;
});

test("a parent signs in, stays signed in across a reload, and signs out", async ({
  page,
}) => {
  await page.goto("/");

  // The gate shows sign-in, and no household data, before authentication.
  await expect(page.getByRole("heading", { name: "Our Family Hub" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon)/ })).toHaveCount(0);

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The dashboard loads the household through RLS.
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
  await expect(page.getByText("Parent One").first()).toBeVisible();

  // The session survives a reload: a static export has no server to hold it,
  // so this is really a check that the browser session persists.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon)/ })).toHaveCount(0);
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

/**
 * HAL-1545 — the forgot-password flow.
 *
 * A family app whose only way back in is "ask the person who set it up" is a
 * trap, so this is a real route rather than a dashboard chore. These run
 * against the built export, like everything else here.
 */

test("a parent can ask for a reset link without revealing who has an account", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Forgot your password?" }).click();

  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();

  // An address that certainly has no account here.
  await page.getByLabel("Email").fill("definitely-nobody@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();

  const status = page.getByRole("main").getByRole("status");
  await expect(status).toBeVisible();
  // The whole point: the same answer either way. Anything that distinguished
  // the two would let a stranger on a public URL test which addresses exist.
  await expect(status).toHaveText(/if an account exists/i);
  await expect(status).not.toHaveText(/no account|not found|unknown|doesn't exist/i);
});

test("the reset form carries the email already typed, and can be backed out of", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("someone@example.test");
  await page.getByRole("button", { name: "Forgot your password?" }).click();

  await expect(page.getByLabel("Email")).toHaveValue("someone@example.test");

  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a dead reset link says so instead of spinning", async ({ page }) => {
  // Supabase reports a used or expired link in the URL fragment, which never
  // reaches a server — so the page has to notice it client-side.
  await page.goto(
    "/reset/#error=access_denied&error_code=otp_expired" +
      "&error_description=Email+link+is+invalid+or+has+expired",
  );

  // Scoped to the page's own content: Next renders a route announcer with
  // role="alert" outside <main>, which would otherwise match too.
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveText(/invalid or has expired/i);
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
  // And it must not be offering a password box for a link that is no good.
  await expect(page.getByLabel("New password")).toHaveCount(0);
});

test("the reset page does not offer a password box without a session", async ({ page }) => {
  await page.goto("/reset/");
  // No token at all: it waits briefly, then says the link is no good rather
  // than presenting a form that could not possibly work.
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("New password")).toHaveCount(0);
});
