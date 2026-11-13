#!/usr/bin/env node
/**
 * Apply the reverse migrations, newest first.
 *
 * HAL-1538 §5: "every migration is forward-only with a working reverse
 * migration". A reverse migration nobody ever runs is a claim, not a rollback —
 * this script is what makes it checkable, and `npm run db:reset && npm run
 * db:down` is the evidence for HAL-1539 AC3.
 *
 * This DROPS the local schema. It refuses to run against anything but a local
 * database, because Environment boundaries puts destructive commands on
 * non-disposable data behind explicit authorization, and a rollback script is
 * exactly the sort of thing that gets pointed at the wrong target.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const DOWN_DIR = path.join(process.cwd(), "supabase", "down");
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const host = new URL(DATABASE_URL.replace(/^postgres(ql)?:/, "http:")).hostname;
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(
    `Refusing to run reverse migrations against ${host}. ` +
      "This script drops the whole schema and is for the local, disposable " +
      "stack only.",
  );
  process.exit(1);
}

const files = (await readdir(DOWN_DIR))
  .filter((f) => f.endsWith(".down.sql"))
  .sort()
  .reverse(); // newest first — the mirror image of how they were applied

if (files.length === 0) {
  console.error(`No reverse migrations found in ${DOWN_DIR}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  for (const file of files) {
    const sql = await readFile(path.join(DOWN_DIR, file), "utf8");
    process.stdout.write(`Reverting ${file} ... `);
    await client.query(sql);
    console.log("ok");
  }

  // Prove it actually reversed, rather than trusting that each statement ran.
  const { rows } = await client.query(`
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  `);
  if (rows.length > 0) {
    console.error(
      `\nReverse migrations left ${rows.length} table(s) behind: ` +
        rows.map((r) => r.relname).join(", "),
    );
    process.exitCode = 1;
  } else {
    console.log("\npublic schema is empty — reverse migrations are complete.");
  }
} catch (error) {
  console.error(`\nFailed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
