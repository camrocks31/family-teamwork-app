import pg from "pg";

/**
 * Integration tests run against the real local Postgres, not a mock.
 *
 * The Testing Standard is explicit that where substituting a mock could hide
 * the failure, use the real engine — and every invariant under test here is a
 * database constraint. A mock would prove nothing: the whole claim is that
 * Postgres itself refuses the row.
 */
export const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function makePool(): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
}

/** Run a statement and return the Postgres error, asserting that it failed. */
export async function expectRejected(
  pool: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<pg.DatabaseError> {
  try {
    await pool.query(sql, params as never[]);
  } catch (error) {
    return error as pg.DatabaseError;
  }
  throw new Error(
    `Expected the database to refuse this statement, but it succeeded:\n${sql}`,
  );
}

/**
 * Run a test inside a transaction that is always rolled back, so a test that
 * has to insert a valid row first (to then prove the second is refused) leaves
 * the database exactly as it found it.
 */
export async function withRollback<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** Run a statement on a client and return the error, asserting that it failed. */
export async function expectClientRejected(
  client: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<pg.DatabaseError> {
  try {
    await client.query(sql, params as never[]);
  } catch (error) {
    return error as pg.DatabaseError;
  }
  throw new Error(
    `Expected the database to refuse this statement, but it succeeded:\n${sql}`,
  );
}

/** Ids from the committed seed, looked up by their generic placeholder names. */
export async function seedIds(pool: pg.Pool) {
  const { rows } = await pool.query<{
    household_id: string;
    children_bedroom: string;
    adult_bedroom: string;
    shared_bedroom: string;
    kitchen: string;
  }>(`
    select
      h.id as household_id,
      (select id from household_spaces where household_id = h.id and name = 'Children''s Bedroom') as children_bedroom,
      (select id from household_spaces where household_id = h.id and name = 'Adult Bedroom')       as adult_bedroom,
      (select id from household_spaces where household_id = h.id and name = 'Shared Bedroom')      as shared_bedroom,
      (select id from household_spaces where household_id = h.id and name = 'Kitchen')             as kitchen
    from households h
    limit 1
  `);
  if (rows.length === 0) throw new Error("No household found — run `npm run db:reset`.");
  return rows[0];
}

/** A shared definition and a per-member definition from the seed. */
export async function sampleDefinitions(pool: pg.Pool) {
  const shared = await pool.query<{ id: string; revision_id: string; household_id: string }>(
    `select td.id, td.current_revision_id as revision_id, td.household_id
       from task_definitions td
      where td.occurrence_mode = 'shared'
      limit 1`,
  );
  const perMember = await pool.query<{ id: string; revision_id: string; household_id: string }>(
    `select td.id, td.current_revision_id as revision_id, td.household_id
       from task_definitions td
      where td.occurrence_mode = 'per_member'
      limit 1`,
  );
  return { shared: shared.rows[0], perMember: perMember.rows[0] };
}

export async function aChildId(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from family_members where role = 'child' limit 1`,
  );
  return rows[0].id;
}

/**
 * Run a query as a given signed-in family member, the way the browser does.
 *
 * The readiness and transition functions are SECURITY DEFINER and derive both
 * the actor and the household from the session, so a test that queried as the
 * superuser would prove nothing about who is allowed to see or do what.
 */
export async function asMember<T>(
  pool: pg.Pool,
  authId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("set role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ sub: authId, role: "authenticated" }),
    ]);
    return await fn(client);
  } finally {
    await client.query("reset role").catch(() => {});
    await client
      .query("select set_config('request.jwt.claims', null, false)")
      .catch(() => {});
    client.release();
  }
}

/**
 * Give a seeded parent a real login and return the ids, idempotently.
 *
 * Children deliberately cannot have one (the schema forbids it), so every test
 * that needs an acting principal uses a parent until slice 5 brings the device
 * and actor-token paths.
 */
export async function linkParent(
  pool: pg.Pool,
  displayName: string,
  email: string,
): Promise<{ memberId: string; authId: string; householdId: string }> {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { data: existing } = await admin.auth.admin.listUsers();
  let authId = existing.users.find((u) => u.email === email)?.id;
  if (!authId) {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "test-only-password",
      email_confirm: true,
    });
    if (error) throw error;
    authId = data.user.id;
  }

  const { rows } = await pool.query<{ id: string; household_id: string }>(
    `update family_members set auth_user_id = $1 where display_name = $2
     returning id, household_id`,
    [authId, displayName],
  );
  if (rows.length === 0) throw new Error(`No member named ${displayName}`);
  return { memberId: rows[0].id, authId: authId!, householdId: rows[0].household_id };
}
