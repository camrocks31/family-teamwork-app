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
