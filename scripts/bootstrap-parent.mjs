#!/usr/bin/env node
/**
 * Create the first parent account and link it to a family member.
 *
 * There is no public sign-up (HAL-1539 §5). The app is served from a public
 * URL, so a sign-up form would let anyone in the world create an account
 * against this household's backend. Accounts are made here instead, locally,
 * by someone who already has the service-role key — and after the first parent
 * exists, further parents are invited from Settings.
 *
 * Children never get an account. They are family_members rows reached by
 * selecting a profile and entering a PIN on an enrolled device (slice 5).
 *
 *   npm run bootstrap:parent -- --member "Parent One"
 *
 * Reads BOOTSTRAP_PARENT_EMAIL, BOOTSTRAP_PARENT_PASSWORD,
 * NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.BOOTSTRAP_PARENT_EMAIL;
const password = process.env.BOOTSTRAP_PARENT_PASSWORD;

const memberFlag = process.argv.indexOf("--member");
const memberName = memberFlag > -1 ? process.argv[memberFlag + 1] : null;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!url || !serviceKey) {
  fail(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.\n" +
      "`npx supabase status` prints both for the local stack.",
  );
}
if (!email || !password) {
  fail("Set BOOTSTRAP_PARENT_EMAIL and BOOTSTRAP_PARENT_PASSWORD in .env.local.");
}
if (!memberName) {
  fail('Which family member is this account for?  --member "Parent One"');
}

// The service-role key bypasses RLS entirely. Refuse to point it anywhere but
// a local stack without an explicit override, so a stray .env never lets this
// run against a real household.
const isLocal = /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(url);
if (!isLocal && process.env.BOOTSTRAP_ALLOW_REMOTE !== "yes") {
  fail(
    `Refusing to run against ${url}.\n` +
      "This uses the service-role key, which bypasses row level security. " +
      "Set BOOTSTRAP_ALLOW_REMOTE=yes only if you are certain.",
  );
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: member, error: memberError } = await admin
  .from("family_members")
  .select("id, display_name, role, auth_user_id")
  .eq("display_name", memberName)
  .maybeSingle();

if (memberError) fail(`Could not read family members: ${memberError.message}`);
if (!member) fail(`No family member named "${memberName}". Run \`npm run db:reset\` first.`);
if (member.role !== "parent") {
  fail(
    `"${memberName}" is a ${member.role}, not a parent. Children do not get ` +
      "accounts — they use a profile and PIN on an enrolled device.",
  );
}
if (member.auth_user_id) {
  fail(`"${memberName}" already has an account linked.`);
}

const { data: created, error: createError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (createError) fail(`Could not create the account: ${createError.message}`);

const { error: linkError } = await admin
  .from("family_members")
  .update({ auth_user_id: created.user.id })
  .eq("id", member.id);

if (linkError) {
  // Leave nothing half-made: an auth user with no member row can sign in and
  // see an empty app, which is confusing rather than dangerous, but still wrong.
  await admin.auth.admin.deleteUser(created.user.id);
  fail(`Could not link the account, so it was removed again: ${linkError.message}`);
}

console.log(`Linked a sign-in for "${member.display_name}".`);
console.log("Sign in at the app with the email and password from .env.local.");
