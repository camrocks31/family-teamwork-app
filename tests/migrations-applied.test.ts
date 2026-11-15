import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatFailure,
  inspectLedger,
  projectRefFrom,
  requiredVersions,
} from "../scripts/check-migrations-applied.mjs";

/**
 * HAL-1556. The deploy gate that would have caught the 2026-11-15 incident.
 *
 * That day a merge to `main` published a bundle selecting four columns the
 * hosted database did not have, and /settings returned 42703 for all four. CI
 * was green: every check it runs is true of the LOCAL stack, where every
 * migration is applied by definition.
 *
 * The fixture is the real stdout of the invocation the gate actually makes —
 * `migration list --remote=<ref> --output-format json --agent no` — captured
 * from the hosted project. An earlier version of this file used output from a
 * DIFFERENT command (`--linked`, with its deprecation warning and the stderr
 * preamble merged in) and called it stdout. A reviewer caught that; a fixture
 * from the wrong command tests the wrong thing.
 */

/** Verbatim stdout. Pure JSON: on CLI 3.1.0 the preamble goes to stderr. */
const LEDGER = String.raw`{"migrations":[{"local":"20261113160000","remote":"20261113160000","time":"2026-11-13 16:00:00"},{"local":"20261113160100","remote":"20261113160100","time":"2026-11-13 16:01:00"},{"local":"20261113160200","remote":"20261113160200","time":"2026-11-13 16:02:00"},{"local":"20261113160300","remote":"20261113160300","time":"2026-11-13 16:03:00"},{"local":"20261113160400","remote":"20261113160400","time":"2026-11-13 16:04:00"},{"local":"20261113160500","remote":"20261113160500","time":"2026-11-13 16:05:00"},{"local":"20261113160600","remote":"20261113160600","time":"2026-11-13 16:06:00"},{"local":"20261113210000","remote":"20261113210000","time":"2026-11-13 21:00:00"},{"local":"20261113210100","remote":"20261113210100","time":"2026-11-13 21:01:00"},{"local":"20261113220000","remote":"20261113220000","time":"2026-11-13 22:00:00"},{"local":"20261113230000","remote":"20261113230000","time":"2026-11-13 23:00:00"},{"local":"20261114000000","remote":"20261114000000","time":"2026-11-14 00:00:00"},{"local":"20261114000100","remote":"20261114000100","time":"2026-11-14 00:01:00"},{"local":"20261114010000","remote":"20261114010000","time":"2026-11-14 01:00:00"},{"local":"20261114010100","remote":"20261114010100","time":"2026-11-14 01:01:00"},{"local":"20261114020000","remote":"20261114020000","time":"2026-11-14 02:00:00"},{"local":"20261114030000","remote":"20261114030000","time":"2026-11-14 03:00:00"},{"local":"20261114030100","remote":"20261114030100","time":"2026-11-14 03:01:00"},{"local":"20261114040000","remote":"20261114040000","time":"2026-11-14 04:00:00"},{"local":"20261114050000","remote":"20261114050000","time":"2026-11-14 05:00:00"},{"local":"20261114060000","remote":"20261114060000","time":"2026-11-14 06:00:00"},{"local":"20261114070000","remote":"20261114070000","time":"2026-11-14 07:00:00"},{"local":"20261114080000","remote":"20261114080000","time":"2026-11-14 08:00:00"},{"local":"20261114090000","remote":"20261114090000","time":"2026-11-14 09:00:00"},{"local":"20261114100000","remote":"20261114100000","time":"2026-11-14 10:00:00"},{"local":"20261114110000","remote":"20261114110000","time":"2026-11-14 11:00:00"},{"local":"20261115100000","remote":"20261115100000","time":"2026-11-15 10:00:00"}],"message":"Migrations listed","target":{"kind":"linked","project_ref":"dadnppnkjetshlraubyn","project_name":"Family Teamwork App","environment":"production"}}`;

/** The 27 versions this checkout requires, as the real ledger reports them. */
const REQUIRED = [
  "20261113160000",
  "20261113160100",
  "20261113160200",
  "20261113160300",
  "20261113160400",
  "20261113160500",
  "20261113160600",
  "20261113210000",
  "20261113210100",
  "20261113220000",
  "20261113230000",
  "20261114000000",
  "20261114000100",
  "20261114010000",
  "20261114010100",
  "20261114020000",
  "20261114030000",
  "20261114030100",
  "20261114040000",
  "20261114050000",
  "20261114060000",
  "20261114070000",
  "20261114080000",
  "20261114090000",
  "20261114100000",
  "20261114110000",
  "20261115100000"
];

/** The same ledger as it stood while /settings was down: the last one absent. */
const OUT_OF_STEP = LEDGER.replace(
  '{"local":"20261115100000","remote":"20261115100000"',
  '{"local":"20261115100000","remote":""',
);

describe("against the real incident", () => {
  it("refuses the ledger that was live when /settings went down", () => {
    const result = inspectLedger(OUT_OF_STEP, REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.unapplied).toEqual(["20261115100000"]);
    expect(result.problem).toBeNull();
  });

  it("names the migration and the command that applies it", () => {
    const message = formatFailure(inspectLedger(OUT_OF_STEP, REQUIRED));
    expect(message).toContain("20261115100000");
    expect(message).toContain("supabase db push --remote");
  });

  it("allows the real ledger once the migration is applied", () => {
    const result = inspectLedger(LEDGER, REQUIRED);
    expect(result.ok).toBe(true);
    expect(result.unapplied).toEqual([]);
  });

  it("really read 27 rows, so the pass is not a silent parse failure", () => {
    expect(inspectLedger(LEDGER, REQUIRED).examined).toBe(27);
    expect(inspectLedger(OUT_OF_STEP, REQUIRED).examined).toBe(27);
  });

  it("holds this checkout, not the CLI, as the authority on what is required", async () => {
    const { versions, problem } = await requiredVersions(
      path.join(import.meta.dirname, "..", "supabase", "migrations"),
    );
    expect(problem).toBeNull();
    expect(versions).toEqual(REQUIRED);
  });
});

/**
 * The finding that mattered most, from both reviewers independently: the first
 * revision asked the CLI what was required AND what was applied, so anything
 * that emptied or shortened its `local` column reported "safe to publish".
 */
describe("completeness is measured against the files on disk", () => {
  it("refuses an EMPTY ledger while this checkout holds migrations", () => {
    const result = inspectLedger('{"migrations":[]}', REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.unapplied).toEqual(REQUIRED);
  });

  it("refuses a ledger reporting only some of them", () => {
    const result = inspectLedger(
      JSON.stringify({ migrations: [{ local: REQUIRED[0], remote: REQUIRED[0] }] }),
      REQUIRED,
    );
    expect(result.ok).toBe(false);
    expect(result.unapplied).toEqual(REQUIRED.slice(1));
  });

  it("passes when a checkout genuinely requires nothing", () => {
    expect(inspectLedger('{"migrations":[]}', []).ok).toBe(true);
  });
});

describe("it fails closed on anything it cannot establish", () => {
  it.each([
    ["an empty string", ""],
    ["only whitespace", "   \n  "],
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["output with no JSON", "Initialising login role...\nconnection refused"],
    ["truncated JSON", '{"migrations":[{"local":"2026'],
    ["JSON that is not an object", "[1,2,3]"],
    ["no migrations key", '{"message":"Migrations listed"}'],
    ["migrations null", '{"migrations":null}'],
    ["migrations a string", '{"migrations":"20261115100000"}'],
    ["migrations an object", '{"migrations":{"local":"x"}}'],
    ["a row that is not an object", '{"migrations":[42]}'],
    ["a row with no version at all", '{"migrations":[{}]}'],
    ["a numeric version", '{"migrations":[{"local":20261115100000}]}'],
    ["a version that is not 14 digits", '{"migrations":[{"local":"1","remote":"1"}]}'],
    ["a renamed output schema", '{"migrations":[{"version":"20261115100000","applied_at":null}]}'],
    [
      "a row pairing two different versions",
      '{"migrations":[{"local":"20261115100000","remote":"20261114110000"}]}',
    ],
  ])("fails on %s", (_label, raw) => {
    const result = inspectLedger(raw as string, REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.problem).toBeTruthy();
    expect(formatFailure(result)).toContain("could not");
  });

  it("refuses two ledgers in one stream rather than taking the first", () => {
    const passing = JSON.stringify({ migrations: REQUIRED.map((v) => ({ local: v, remote: v })) });
    const failing = JSON.stringify({ migrations: [{ local: REQUIRED[0], remote: "" }] });
    const result = inspectLedger(`${passing}\n${failing}`, REQUIRED);
    expect(result.ok).toBe(false);
    // Refused because two objects are not one JSON document. The earlier
    // revision refused this particular shape by de-duplicating candidates,
    // which missed the pretty-printed shape entirely.
    expect(result.problem).toContain("not a single JSON document");
  });

  it("says so specifically when the CLI printed a table instead of JSON", () => {
    // The measured --remote header, not an invented one.
    const table = [
      "   Local            | Remote           | Time (UTC)",
      "  ------------------|------------------|-----------",
      "   `20261113160000` | `20261113160000` | `t`",
    ].join("\n");
    const result = inspectLedger(table, REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("--output-format json");
  });

  it("never echoes a CLI-supplied string into the log", () => {
    // Reproduced before the fix: a planted credential in a version field came
    // back verbatim in the failure message.
    const planted = JSON.stringify({
      migrations: [{ local: "sbp_0123456789abcdefSECRET", remote: "" }],
    });
    const message = formatFailure(inspectLedger(planted, REQUIRED));
    expect(message).not.toContain("sbp_0123456789abcdefSECRET");
    expect(message).toContain("could not");
  });
});

describe("drift in the safe direction is reported, not blocked", () => {
  it("passes but flags a migration applied remotely and absent here", () => {
    const rows = REQUIRED.map((v) => ({ local: v, remote: v }));
    rows.push({ local: "", remote: "20991231235959" });
    const result = inspectLedger(JSON.stringify({ migrations: rows }), REQUIRED);
    // Blocking here would brick the pipeline after the obvious response to the
    // incident: reverting a migration.
    expect(result.ok).toBe(true);
    expect(result.orphans).toEqual(["20991231235959"]);
  });
});

describe("which project it asks", () => {
  const REF = "dadnppnkjetshlraubyn";

  it("derives the ref from the URL the bundle is built against", () => {
    expect(projectRefFrom({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` })).toEqual({
      ref: REF,
      problem: null,
    });
  });

  it("accepts an explicit ref that agrees with the URL", () => {
    expect(
      projectRefFrom({
        SUPABASE_PROJECT_REF: REF,
        NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
      }).ref,
    ).toBe(REF);
  });

  // Letting the override win silently defeated the entire reason for deriving
  // the ref from the URL: the gate could clear project A while the bundle was
  // built against project B.
  it("refuses an explicit ref that disagrees with the URL", () => {
    const result = projectRefFrom({
      SUPABASE_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa",
      NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
    });
    expect(result.ref).toBeNull();
    expect(result.problem).toContain("different project");
  });

  it.each([
    ["nothing is set", {}, "neither SUPABASE_PROJECT_REF nor NEXT_PUBLIC_SUPABASE_URL"],
    ["the URL is a local stack", { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, "local stack"],
    ["the URL is localhost", { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" }, "local stack"],
    ["the URL is not a URL", { NEXT_PUBLIC_SUPABASE_URL: "not a url" }, "not a URL"],
    ["the URL is blank", { NEXT_PUBLIC_SUPABASE_URL: "   " }, "neither SUPABASE_PROJECT_REF"],
    ["an explicit ref is malformed", { SUPABASE_PROJECT_REF: "--debug" }, "not a project ref"],
    // These three are host-suffix attacks. An earlier version of this table
    // used "https://evil.com/x.supabase.co", whose hostname is evil.com — it
    // tested a PATH and passed for a reason unrelated to its label.
    ["the host is a lookalike", { NEXT_PUBLIC_SUPABASE_URL: "https://evil-supabase.co" }, "not a hosted Supabase project URL"],
    ["the host is a subdomain of one", { NEXT_PUBLIC_SUPABASE_URL: "https://a.b.supabase.co" }, "not a hosted Supabase project URL"],
    ["the host only ends in it", { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co.attacker.com" }, "not a hosted Supabase project URL"],
    ["userinfo fakes the host", { NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co@evil.com/` }, "not a hosted Supabase project URL"],
  ])("refuses to guess when %s", (_label, env, expected) => {
    const result = projectRefFrom(env as Record<string, string | undefined>);
    expect(result.ref).toBeNull();
    expect(result.problem).toContain(expected);
  });
});

/**
 * The command boundary. No test touched this before, and it is where the worst
 * defect lived: the exit status was consulted only when parsing had ALSO
 * failed, so a CLI that errored while printing a healthy ledger was accepted.
 *
 * These run the real script with a fake `npx` first on PATH.
 */
describe("the command boundary", () => {
  const GATE = path.join(import.meta.dirname, "..", "scripts", "check-migrations-applied.mjs");
  const healthy = JSON.stringify({ migrations: REQUIRED.map((v) => ({ local: v, remote: v })) });

  /** @returns {{status:number, out:string}} */
  function runGateWithFakeCli(body: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-shim-"));
    const shim = path.join(dir, "npx");
    writeFileSync(shim, `#!/bin/sh
${body}
`);
    chmodSync(shim, 0o755);
    try {
      const out = execFileSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          NEXT_PUBLIC_SUPABASE_URL: "https://dadnppnkjetshlraubyn.supabase.co",
          SUPABASE_PROJECT_REF: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("passes when the CLI succeeds and the ledger is complete", () => {
    const { status, out } = runGateWithFakeCli(`cat <<'J'
${healthy}
J`);
    expect(status).toBe(0);
    expect(out).toContain("Safe to publish");
  });

  // Reproduced against the first revision: exit 0, "Safe to publish".
  it("refuses a healthy ledger from a CLI that exited non-zero", () => {
    const { status, out } = runGateWithFakeCli(`cat <<'J'
${healthy}
J
exit 3`);
    expect(status).toBe(1);
    expect(out).toContain("exited with status 3");
    expect(out).not.toContain("Safe to publish");
  });

  // The shape of a spawnSync timeout kill: status null, signal set.
  it("refuses a healthy ledger from a CLI that was killed", () => {
    const { status, out } = runGateWithFakeCli(`cat <<'J'
${healthy}
J
kill -9 $$`);
    expect(status).toBe(1);
    expect(out).toContain("killed by");
    expect(out).not.toContain("Safe to publish");
  });

  it("refuses an empty ledger even when the CLI is perfectly happy", () => {
    const { status, out } = runGateWithFakeCli(`echo '{"migrations":[]}'`);
    expect(status).toBe(1);
    expect(out).toContain("not applied to the hosted project");
  });

  it("refuses when the CLI writes nothing at all", () => {
    const { status, out } = runGateWithFakeCli("exit 0");
    expect(status).toBe(1);
    expect(out).toContain("could not");
  });
});

/**
 * Round 2. The JSON hunt is gone: stdout must be ONE JSON document.
 *
 * The lenient extractor let a second payload hide. A de-duplicating patch
 * closed the compact shape and missed the pretty-printed one — the same defect
 * patched twice — so the mechanism was removed instead.
 */
describe("stdout must be one JSON document", () => {
  const healthy = JSON.stringify({ migrations: REQUIRED.map((v) => ({ local: v, remote: v })) });

  it("refuses a healthy ledger followed by a PRETTY-PRINTED empty one", () => {
    // Reproduced passing against the de-duplicating revision: a pretty object
    // opens with a bare `{` line, which JSON.parse rejects, so it never became
    // a second candidate and the first payload won.
    const stream = `${healthy}\n${JSON.stringify({ migrations: [] }, null, 2)}`;
    const result = inspectLedger(stream, REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("not a single JSON document");
  });

  it("refuses a healthy ledger followed by a compact failing one", () => {
    const stream = `${healthy}\n${JSON.stringify({ migrations: [{ local: REQUIRED[0], remote: "" }] })}`;
    expect(inspectLedger(stream, REQUIRED).ok).toBe(false);
  });

  it("refuses a preamble on stdout rather than hunting past it", () => {
    // Measured: with --output-format json the preamble goes to stderr, so a
    // preamble on STDOUT means something changed and a human should look.
    const noisy = `Target: project X\nInitialising login role...\n${healthy}`;
    const result = inspectLedger(noisy, REQUIRED);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("not a single JSON document");
  });

  it("still accepts the real ledger with its trailing newline", () => {
    expect(inspectLedger(`${LEDGER}\n`, REQUIRED).ok).toBe(true);
  });
});

describe("the required list cannot be omitted", () => {
  it.each([
    ["omitted", undefined],
    ["null", null],
    ["a number", 27],
    ["a string", "20261115100000"],
  ])("refuses when the required list is %s", (_label, required) => {
    const result = inspectLedger(LEDGER, required as unknown as string[]);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain("was not supplied");
  });
});

describe("what this checkout requires", () => {
  it("refuses a directory that yields no migration files", async () => {
    // "all 0 migrations are applied. Safe to publish." is the same empty
    // reassurance an empty hosted ledger used to give.
    const dir = mkdtempSync(path.join(tmpdir(), "no-migrations-"));
    writeFileSync(path.join(dir, "README.md"), "not a migration");
    const { versions, problem } = await requiredVersions(dir);
    expect(versions).toEqual([]);
    expect(problem).toContain("no migration files were found");
  });

  it("refuses a directory it cannot read", async () => {
    const { problem } = await requiredVersions(
      path.join(tmpdir(), "definitely-not-here-ab12cd34"),
    );
    expect(problem).toContain("could not be read");
  });

  it("refuses a filename that does not begin with a version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bad-name-"));
    writeFileSync(path.join(dir, "20261115100000_fine.sql"), "");
    writeFileSync(path.join(dir, "oops_no_version.sql"), "");
    const { problem } = await requiredVersions(dir);
    expect(problem).toContain("does not begin with a version");
  });
});
