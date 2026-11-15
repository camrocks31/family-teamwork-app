#!/usr/bin/env node
/**
 * Refuse to publish while the hosted database is behind the bundle.
 *
 * HAL-1556. On 2026-11-15 a merge to `main` published a bundle that selected
 * four columns the hosted project did not have. `/settings` returned `42703`
 * for every one of them. CI was green the whole time, and it was right to be:
 * every check in the `check` job runs against the LOCAL stack, where every
 * migration in `supabase/migrations/` is applied by definition. The one state
 * that breaks the live site is the one state nothing looked at.
 *
 *   node scripts/check-migrations-applied.mjs
 *
 * WHAT IS TREATED AS TRUE, and why it is arranged this way.
 *
 *   THIS CHECKOUT says what MUST be applied. The versions are read from the
 *   filenames in `supabase/migrations/`, not from the CLI. An earlier revision
 *   trusted the CLI's `local` column for both halves of the comparison, which
 *   meant an empty ledger — the loudest possible sign of being pointed at the
 *   wrong project — reported "safe to publish". Two reviewers found that
 *   independently and they were right.
 *
 *   THE LEDGER says what IS applied, through its `remote` column alone. The
 *   `local` column is read only to notice disagreement, never to decide.
 *
 * FAIL CLOSED, and this file has already failed to keep that promise once.
 * A missing token, a non-zero exit, a timeout, a signal, output that cannot be
 * parsed, a row with no readable version, two different ledgers in one stream:
 * all refuse. The first version of this script checked the exit status only
 * when parsing had ALSO failed, so a CLI that errored while printing a healthy
 * ledger sailed through — reproduced, exit 0, "Safe to publish".
 *
 * WHAT THIS DOES NOT ESTABLISH. It compares the migration LEDGER, not the
 * schema. A migration recorded as applied but only partly executed reads as in
 * step, which is the incident's own symptom. A hand-edited hosted schema is
 * equally invisible. The gate closes an ordering mistake; it is not a schema
 * audit.
 *
 * ONE THING THAT IS EASY TO GET WRONG, found by running it the way CI does
 * rather than by reasoning about it: `--output-format json` IS REQUIRED.
 * Without it the CLI picks a format from whether it thinks an agent is calling
 * it — JSON by hand inside an agent, a text table in GitHub Actions. A parser
 * assuming JSON would therefore have failed on every real deploy and nowhere
 * else, and a gate that blocks everything is not safer than no gate; it just
 * gets deleted.
 *
 * On CLI 3.1.0, with that flag, STDOUT IS PURE JSON and the `Target:` and
 * `Initialising login role...` lines go to stderr — measured, after an earlier
 * version of this comment asserted the opposite. Stdout is therefore parsed
 * strictly, as one JSON document and nothing else. A preamble appearing there
 * would REFUSE rather than be skipped past, which is deliberate: it would mean
 * the format changed under us, and that is a thing to be looked at rather than
 * tolerated. (A previous revision of this sentence called the extraction
 * "defensive against a future change" — it described the tolerant hunt that
 * `extractLedger` no longer has.)
 */
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Supabase migration versions are 14-digit timestamps. Nothing else is one. */
const VERSION = /^\d{14}$/;

/** A project ref is a fixed-length lowercase alphanumeric string. */
const PROJECT_REF = /^[a-z0-9]{20}$/;

/**
 * @typedef {object} Field
 * @property {string}  value
 * @property {boolean} absent    Nothing was there at all.
 * @property {boolean} malformed Something was there and it is not a version.
 */

/** @returns {Field} */
function readVersion(value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return { value: "", absent: true, malformed: false };
  }
  if (typeof value !== "string" || !VERSION.test(value.trim())) {
    return { value: "", absent: false, malformed: true };
  }
  return { value: value.trim(), absent: false, malformed: false };
}

/**
 * @typedef {object} Inspection
 * @property {boolean}  ok         Safe to publish.
 * @property {number}   examined   Rows read from the hosted ledger.
 * @property {number}   required   Migration files in this checkout.
 * @property {string[]} unapplied  Required versions the hosted project lacks.
 * @property {string[]} orphans    Applied versions this checkout does not have.
 * @property {string|null} problem Why no answer could be established.
 */

/**
 * Read the ledger from stdout, as ONE JSON document and nothing else.
 *
 * Deliberately strict, and it did not start that way. The first revision
 * hunted for JSON — whole string, then each line, then the first `{` to the
 * last `}` — so that a preamble could not defeat it. That preamble does not
 * exist on stdout (measured: see the header), and the hunt let a second
 * payload hide: a compact healthy ledger followed by a PRETTY-PRINTED empty
 * one parsed to exactly one candidate, because a pretty object begins with a
 * bare `{` line that JSON.parse rejects. The first payload then won. A
 * de-duplicating patch closed the compact shape of that and missed this one,
 * which is the second time the same defect was patched rather than removed.
 *
 * So the mechanism is gone. Anything that is not a single JSON document is
 * refused. If a future CLI starts writing prose to stdout this check blocks
 * deploys until somebody looks — which is the correct direction for a gate,
 * and the message says exactly what it saw.
 *
 * The raw output is NEVER quoted in the returned reason: on an error path it
 * can carry the project ref, and in principle a credential, and this text is
 * printed in a public CI log.
 */
function extractLedger(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "the command produced no output";
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // The specific likely cause: the format flag was dropped and the CLI chose
    // a table. Measured `--remote` header: `Local | Remote | Time (UTC)`.
    if (/\bLocal\b.*\|/.test(raw)) {
      return "the command printed a table instead of JSON — it needs --output-format json";
    }
    return "the output was not a single JSON document";
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "the output was JSON but not an object";
  }
  if (!("migrations" in parsed)) {
    return "the output was JSON but carried no migration ledger";
  }
  return parsed;
}

/**
 * Decide whether the hosted database can serve this checkout.
 *
 * @param {string} raw stdout of `supabase migration list --remote=<ref>`
 * @param {string[]} required versions read from `supabase/migrations/`
 * @returns {Inspection}
 */
export function inspectLedger(raw, required) {
  // No default. An omitted list used to mean "nothing is required", which is
  // indistinguishable from "everything is applied" and would turn the gate off
  // for a future caller who forgot it.
  if (!Array.isArray(required)) {
    return {
      ok: false, examined: 0, required: 0, unapplied: [], orphans: [],
      problem: "the list of required migrations was not supplied",
    };
  }
  const blank = { ok: false, examined: 0, required: required.length, unapplied: [], orphans: [] };

  const ledger = extractLedger(raw);
  if (typeof ledger === "string") return { ...blank, problem: ledger };

  const rows = ledger.migrations;
  if (!Array.isArray(rows)) {
    return { ...blank, problem: "the migration ledger was not a list" };
  }
  if (rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    return { ...blank, problem: "the migration ledger held an entry that was not a migration" };
  }

  const applied = new Set();
  for (const row of rows) {
    const local = readVersion(row.local);
    const remote = readVersion(row.remote);

    // An unreadable row is indeterminate, never benign. The earlier revision
    // coerced anything unreadable to "absent" and then skipped it, so a
    // renamed output schema would have turned the gate off AND reported
    // success — the single worst behaviour available to it.
    if (local.malformed || remote.malformed) {
      return { ...blank, examined: rows.length, problem: "the hosted ledger held a malformed version" };
    }
    if (local.absent && remote.absent) {
      return { ...blank, examined: rows.length, problem: "the hosted ledger held a row with no version" };
    }
    if (local.value && remote.value && local.value !== remote.value) {
      return {
        ...blank,
        examined: rows.length,
        problem: "the hosted ledger paired two different versions in one row",
      };
    }
    if (remote.value) applied.add(remote.value);
  }

  // This checkout decides what is required. The ledger only reports what is
  // applied. That asymmetry is the whole correction from the first revision.
  const unapplied = required.filter((v) => !applied.has(v));
  const orphans = [...applied].filter((v) => !required.includes(v)).sort();

  return {
    ok: unapplied.length === 0,
    examined: rows.length,
    required: required.length,
    unapplied,
    orphans,
    problem: null,
  };
}

/**
 * Which project to ask.
 *
 * Derived from NEXT_PUBLIC_SUPABASE_URL, rather than configured separately, so
 * the ref cannot drift from the URL the bundle is built against: this check
 * then always interrogates the database the published site will talk to.
 *
 * An explicit SUPABASE_PROJECT_REF must AGREE with that URL when both exist.
 * Letting it win silently destroyed the very property above — it could point
 * the gate at project A while the bundle targeted project B, and the gate
 * would pass. Both reviewers caught that.
 *
 * The ref is not a secret: it is the subdomain of a public URL that ships
 * inside the bundle. It travels as a repository variable for the same reason
 * NEXT_PUBLIC_SUPABASE_URL does — a masked value cannot be read in the log of
 * the check that reports which project it asked.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ref: string|null, problem: string|null}}
 */
export function projectRefFrom(env) {
  const explicit = env.SUPABASE_PROJECT_REF?.trim();
  if (explicit && !PROJECT_REF.test(explicit)) {
    return { ref: null, problem: "SUPABASE_PROJECT_REF is not a project ref" };
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!url) {
    if (explicit) return { ref: explicit, problem: null };
    return {
      ref: null,
      problem: "neither SUPABASE_PROJECT_REF nor NEXT_PUBLIC_SUPABASE_URL is set",
    };
  }

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ref: null, problem: "NEXT_PUBLIC_SUPABASE_URL is not a URL" };
  }

  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
    return { ref: null, problem: "NEXT_PUBLIC_SUPABASE_URL points at a local stack" };
  }

  const match = /^([a-z0-9]+)\.supabase\.(co|in|red)$/.exec(host);
  if (!match) {
    return { ref: null, problem: "NEXT_PUBLIC_SUPABASE_URL is not a hosted Supabase project URL" };
  }
  const derived = match[1];

  if (explicit && explicit !== derived) {
    return {
      ref: null,
      problem: "SUPABASE_PROJECT_REF names a different project than the bundle is built against",
    };
  }
  return { ref: derived, problem: null };
}

/**
 * The versions this checkout requires, from the migration filenames.
 *
 * @param {string} dir
 * @returns {Promise<{versions: string[], problem: string|null}>}
 */
export async function requiredVersions(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { versions: [], problem: `${path.basename(dir)} could not be read` };
  }

  const versions = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".sql")) continue;
    const version = name.slice(0, 14);
    if (!VERSION.test(version)) {
      return { versions: [], problem: "a migration filename does not begin with a version" };
    }
    versions.push(version);
  }
  // A checkout of this repository always has migrations. Zero of them means the
  // directory is not the one we think it is, and "all 0 migrations are applied"
  // is the same empty reassurance an empty hosted ledger used to give.
  if (versions.length === 0) {
    return { versions: [], problem: "no migration files were found" };
  }
  return { versions, problem: null };
}

/** @param {Inspection} result */
export function formatFailure(result) {
  if (result.problem) {
    return [
      `The deploy gate could not determine whether the hosted database is in step: ${result.problem}.`,
      "",
      "Publishing is refused, because a bundle newer than its database serves",
      "errors to the family (HAL-1556). This is not a transient failure to retry",
      "past.",
      "",
      "Most likely one of:",
      "  - SUPABASE_ACCESS_TOKEN is missing, expired, or lacks the scopes",
      "    projects_read, database_pooling_config_read and database_write",
      "    on this project — see the step comment in ci.yml for why the last",
      "    one is needed and why it is not narrower",
      "  - the project is paused and must be resumed",
      "  - the Supabase CLI changed its output",
    ].join("\n");
  }

  if (result.ok) return "";

  // Only validated 14-digit versions ever reach here: anything else became a
  // `problem` above with fixed wording. An earlier revision printed parsed
  // values unchecked, and a planted credential in a `local` field was
  // reproduced verbatim in this message.
  const plural = result.unapplied.length === 1 ? "migration is" : "migrations are";
  return [
    `${result.unapplied.length} ${plural} in this checkout but not applied to the hosted project:`,
    ...result.unapplied.map((v) => `  - ${v}`),
    "",
    "The bundle about to be published expects them. Apply them first:",
    "",
    "  npx supabase db push --remote --dry-run   # see what would be applied",
    "  npx supabase db push --remote             # apply it",
    "",
    `${result.required} migrations required by this checkout; ${result.examined} rows in the hosted ledger.`,
  ].join("\n");
}

/** Only when run as a command, so the exported functions stay importable. */
async function main() {
  const { spawnSync } = await import("node:child_process");

  const fail = (problem) => {
    console.error(
      formatFailure({ ok: false, examined: 0, required: 0, unapplied: [], orphans: [], problem }),
    );
    process.exit(1);
  };

  // No pre-check on SUPABASE_ACCESS_TOKEN, on purpose. In CI it is the only way
  // in, so a missing one makes the command below fail and this check fail with
  // it. On a developer's machine the CLI uses the keychain login and no such
  // variable exists, and refusing there would make this script unrunnable by
  // hand — which is exactly when it is most useful, before merging a migration.
  const { ref, problem: refProblem } = projectRefFrom(process.env);
  if (refProblem) fail(refProblem);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { versions, problem: filesProblem } = await requiredVersions(
    path.join(root, "supabase", "migrations"),
  );
  if (filesProblem) fail(filesProblem);

  console.log(`Asking project ${ref} about ${versions.length} migrations in this checkout.`);

  const run = spawnSync(
    "npx",
    ["supabase", "migration", "list", `--remote=${ref}`, "--output-format", "json", "--agent", "no"],
    {
      encoding: "utf8",
      timeout: 120_000,
      // stdin closed: if a future CLI ever asks for a password, it must fail
      // immediately rather than hang until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // BEFORE looking at the output. Not after, and not only when parsing failed
  // — that ordering is what let a CLI exiting 3 report "safe to publish".
  if (run.error) fail("the Supabase CLI could not be run");
  if (run.signal) fail(`the Supabase CLI was killed by ${run.signal}, which includes its timeout`);
  if (run.status !== 0) fail(`the Supabase CLI exited with status ${run.status}`);

  const result = inspectLedger(run.stdout ?? "", versions);
  if (result.problem || !result.ok) {
    console.error(formatFailure(result));
    process.exit(1);
  }

  // Drift worth saying out loud, but not worth blocking a deploy. Blocking
  // would brick the pipeline after the obvious response to this incident —
  // reverting a migration — and leave no way out.
  //
  // It is NOT, however, safe by construction, and an earlier version of this
  // message said it was ("the bundle is older than the schema, not newer").
  // A migration can remove things as well as add them, so an orphan may have
  // dropped a column this older bundle still selects. That is the same failure
  // this whole gate exists to prevent, arriving from the other direction, and
  // a ledger comparison cannot see it. So: warn honestly, do not reassure.
  if (result.orphans.length > 0) {
    console.log(
      `::warning::The hosted project has ${result.orphans.length} migration(s) this checkout does not describe: ${result.orphans.join(", ")}. Publishing anyway, because this gate exists to stop a bundle NEWER than its schema. But a migration can drop things as well as add them: if one of these removed something this bundle still uses, the site can break and this check cannot tell you.`,
    );
  }

  console.log(
    `In step: all ${result.required} migrations required by this checkout are applied. Safe to publish.`,
  );
}

// `node scripts/check-migrations-applied.mjs` runs it; an import does not.
//
// Both sides are realpath-resolved. `import.meta.url` already is, and
// `process.argv[1]` is not, so a single symlink anywhere in the invocation path
// made the comparison fail and the script exit 0 having checked nothing — a
// silent no-op in a file whose header promises the opposite. Reproduced: the
// same gate through a real directory refused, and through a symlink to it
// published. An earlier fix here addressed '#' and '%' in paths, which were
// never the cause.
let invokedAs = "";
try {
  invokedAs = realpathSync(path.resolve(process.argv[1] ?? ""));
} catch {
  /* argv[1] absent or gone: not a direct run */
}
if (invokedAs && realpathSync(fileURLToPath(import.meta.url)) === invokedAs) {
  await main();
}
