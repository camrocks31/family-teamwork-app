#!/usr/bin/env node
/**
 * Apply the untracked local seed overlay, if the household has one.
 *
 * The committed seed carries structure with placeholder names, because the
 * repository is public (HAL-1538 requirement 1). This script applies
 * supabase/seed.local.sql on top, which renames those placeholders to the
 * household's real names. That file is gitignored and absent in CI, so this
 * script is a no-op there rather than a failure.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const LOCAL_SEED = path.join(process.cwd(), "supabase", "seed.local.sql");
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (!existsSync(LOCAL_SEED)) {
  console.log(
    "No supabase/seed.local.sql — keeping the generic seed.\n" +
      "To use your household's real names, copy supabase/seed.local.example.sql " +
      "to supabase/seed.local.sql and edit it. It is gitignored.",
  );
  process.exit(0);
}

const sql = await readFile(LOCAL_SEED, "utf8");
const client = new pg.Client({ connectionString: DATABASE_URL });

try {
  await client.connect();
  await client.query(sql);
  console.log("Applied supabase/seed.local.sql.");
} catch (error) {
  console.error("Failed to apply the local seed:", error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
