import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

/**
 * HAL-1554 — /reset must not change the password of whoever happens to be
 * signed in.
 *
 * The defect: the page treated ANY session as a password-recovery session. On
 * the wall-mounted iPad the restored session is a parent's, and
 * `onAuthStateChange` fires `INITIAL_SESSION` with it the moment the page
 * subscribes — this repo says so itself in `auth-gate.tsx`. So a child could
 * open /reset, type a new password twice, and own the parent account. No
 * email, no recovery link, no knowledge of the old password.
 *
 * The first test here is that attack, and it FAILED before the fix. The
 * second is the journey the page exists for, which must keep working: a
 * genuine recovery link still reaches the form.
 *
 * Both run in a browser against the built export, because the thing under
 * test is which auth event the client reacts to — there is no server-side
 * behaviour to assert here, and a unit test of the component would be
 * asserting against a mock of the one library whose behaviour is the subject.
 */

const RUN = Date.now();
const VICTIM_EMAIL = `e2e-reset-victim-${RUN}@example.test`;
const VICTIM_PASSWORD = "e2e-reset-victim-password";
const RECOVER_EMAIL = `e2e-reset-recover-${RUN}@example.test`;
const RECOVER_PASSWORD = "e2e-reset-recover-password";
const NEW_PASSWORD = "a-brand-new-password-9137";
const GUARD_EMAIL = `e2e-reset-guard-${RUN}@example.test`;
const GUARD_PASSWORD = "e2e-reset-guard-password";
const FORGE_EMAIL = `e2e-reset-forge-${RUN}@example.test`;
const FORGE_PASSWORD = "e2e-reset-forge-password";
const ATTACKER_PASSWORD = "what-an-attacker-would-set-4412";

let admin: SupabaseClient;
let victimUserId: string;
let recoverUserId: string;
let guardUserId: string;
let forgeUserId: string;

/**
 * Refuse to run anywhere but a local, disposable stack.
 *
 * This file holds the service-role key, creates accounts and CHANGES
 * PASSWORDS. Pointed at a real project by a stray .env it would do all of
 * that to a real household.
 *
 * The hostname is parsed rather than string-matched. `bootstrap-parent.mjs`
 * matches the string, and `https://localhost:123@remote.example` passes it
 * while actually addressing a remote host — recorded as HAL-1553. Not
 * repeated here.
 */
function assertLocalTarget(raw: string) {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL is not a URL: ${raw}`);
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(
      `Refusing to run this spec against ${host}. It uses the service-role key ` +
        `and changes passwords; it is for the local, disposable stack only.`,
    );
  }
}

async function makeUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user.id;
}

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("The e2e suite needs the local keys in .env.local.");
  // Before the privileged client exists, not after.
  assertLocalTarget(url);
  admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  victimUserId = await makeUser(VICTIM_EMAIL, VICTIM_PASSWORD);
  recoverUserId = await makeUser(RECOVER_EMAIL, RECOVER_PASSWORD);
  guardUserId = await makeUser(GUARD_EMAIL, GUARD_PASSWORD);
  forgeUserId = await makeUser(FORGE_EMAIL, FORGE_PASSWORD);

  // The attack needs a session the app will restore, which needs a member row
  // — AuthGate signs in anybody, but the dashboard needs a household. Claim a
  // seeded parent for the victim account.
  const { data: parent } = await admin
    .from("family_members")
    .select("id")
    .eq("display_name", "Parent One")
    .single();
  if (!parent) throw new Error("Seed is missing — run `npm run db:reset`.");
  await admin.from("family_members").update({ auth_user_id: null }).eq("auth_user_id", victimUserId);
  await admin.from("family_members").update({ auth_user_id: victimUserId }).eq("id", parent.id);
});

test.afterAll(async () => {
  try {
    await admin.auth.admin.deleteUser(victimUserId);
    await admin.auth.admin.deleteUser(recoverUserId);
    await admin.auth.admin.deleteUser(guardUserId);
    await admin.auth.admin.deleteUser(forgeUserId);
  } catch {
    // Best effort: a cleanup failure must not fail a suite that already proved
    // what it set out to prove.
  }
});

test("a signed-in session cannot use /reset to change its own password", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(VICTIM_EMAIL);
  await page.getByLabel("Password").fill(VICTIM_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible();

  // Exactly what a child would do: type the address.
  await page.goto("/reset/");

  // Wait for the page to SETTLE first. Asserting absence straight after
  // goto() passes before hydration and proves nothing — the original version
  // of this test did exactly that, and only the alert assertion below was
  // doing any work.
  await expect(page.getByRole("main")).toContainText(
    /Checking your link|expired or has already been used/i,
    { timeout: 15_000 },
  );
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    // Scoped to <main>: Next renders a route announcer with role="alert"
    // outside it, which otherwise matches two elements and fails strict mode.
    /expired or has already been used/i,
    { timeout: 15_000 },
  );

  // Only now is absence meaningful.
  await expect(page.getByLabel("New password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save new password" })).toHaveCount(0);
});

test("a genuine recovery link still reaches the form and changes the password", async ({
  page,
}) => {
  // The real journey, driven through Supabase's own verify endpoint — the
  // fragment it redirects with is what makes the client emit
  // PASSWORD_RECOVERY, and that is the whole distinction the fix rests on.
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: RECOVER_EMAIL,
    options: { redirectTo: "http://127.0.0.1:4173/reset/" },
  });
  if (error) throw error;
  const link = data.properties?.action_link;
  expect(link, "the admin API should return a recovery link").toBeTruthy();

  await page.goto(link!);

  await expect(page.getByLabel("New password")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByLabel("Type it again").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Save new password" }).click();

  await expect(page.getByRole("status")).toContainText(/password is changed/i, {
    timeout: 15_000,
  });

  // And it really changed.
  const probe = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { error: newWorks } = await probe.auth.signInWithPassword({
    email: RECOVER_EMAIL,
    password: NEW_PASSWORD,
  });
  expect(newWorks, "the new password must work").toBeNull();
});

/** An anon-key client, the way a browser has one. */
function anonClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

test("the server refuses a password change from an ordinary session", async () => {
  // THE GUARD THAT ACTUALLY HOLDS, and nothing tested it before.
  //
  // The page's event check is a gate, not a boundary: `redirectType` is read
  // straight out of the URL, so it is forgeable (see the next test). What
  // stops the takeover is `require_current_password` on the auth service. Flip
  // that setting off and THIS is the test that goes red — previously the whole
  // suite stayed green either way.
  const user = anonClient();
  const { error: signedIn } = await user.auth.signInWithPassword({
    email: GUARD_EMAIL,
    password: GUARD_PASSWORD,
  });
  expect(signedIn, "the fixture account should sign in").toBeNull();

  const { error } = await user.auth.updateUser({ password: ATTACKER_PASSWORD });
  expect(error, "an ordinary session must NOT be allowed to set a password").not.toBeNull();
  expect(error!.message).toMatch(/current password/i);

  const probe = anonClient();
  const { error: oldStillWorks } = await probe.auth.signInWithPassword({
    email: GUARD_EMAIL,
    password: GUARD_PASSWORD,
  });
  expect(oldStillWorks, "the original password must still work").toBeNull();
  const { error: newRejected } = await anonClient().auth.signInWithPassword({
    email: GUARD_EMAIL,
    password: ATTACKER_PASSWORD,
  });
  expect(newRejected, "the attacker's password must not work").not.toBeNull();
});

test("a forged type=recovery fragment cannot change the password", async ({ page }) => {
  // The gate is forgeable and this test does not pretend otherwise. auth-js
  // validates the access token in the fragment but takes `type` on trust, so a
  // fragment carrying an ordinary session's own tokens plus `type=recovery`
  // makes the client emit PASSWORD_RECOVERY. On a wall tablet those tokens are
  // in localStorage.
  //
  // So the assertion is not "the form stays hidden" — it is the property that
  // actually matters: THE PASSWORD DOES NOT CHANGE.
  const session = await anonClient()
    .auth.signInWithPassword({ email: FORGE_EMAIL, password: FORGE_PASSWORD })
    .then((r) => r.data.session!);
  expect(session?.access_token, "need a real session to forge with").toBeTruthy();

  await page.goto(
    `/reset/#access_token=${session.access_token}` +
      `&refresh_token=${session.refresh_token}` +
      `&expires_in=3600&token_type=bearer&type=recovery`,
  );

  const field = page.getByLabel("New password");
  await page.waitForLoadState("networkidle");
  if ((await field.count()) > 0) {
    await field.fill(ATTACKER_PASSWORD);
    await page.getByLabel("Type it again").fill(ATTACKER_PASSWORD);
    await page.getByRole("button", { name: "Save new password" }).click();
    // Refused, and the page says so rather than claiming success.
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("main")).not.toContainText(/password is changed/i);
  }

  // The property under test, whether or not the form appeared.
  const { error: oldStillWorks } = await anonClient().auth.signInWithPassword({
    email: FORGE_EMAIL,
    password: FORGE_PASSWORD,
  });
  expect(oldStillWorks, "the original password must still work").toBeNull();
  const { error: forgedRejected } = await anonClient().auth.signInWithPassword({
    email: FORGE_EMAIL,
    password: ATTACKER_PASSWORD,
  });
  expect(forgedRejected, "the forged change must not have taken effect").not.toBeNull();
});

