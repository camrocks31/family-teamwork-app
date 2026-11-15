import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HAL-1549 R6 — the interface does not boss anybody.
 *
 * Deci, Eghrari, Patrick & Leone (1994) found three things that move a
 * genuinely dull task toward being internalized: a meaningful rationale, an
 * honest acknowledgement that it is dull, and the ABSENCE OF CONTROLLING
 * LANGUAGE. The first two are features — a reason on every job, and a form
 * that invites one. The third is not a feature, because `src/` already met it
 * when this was written: nothing in it said "you have to".
 *
 * So the deliverable here is the guard rather than a fix. Controlling
 * phrasing is the easiest thing in the world to type into a button label at
 * four in the afternoon, and it is nearly impossible to notice in review
 * because it reads as perfectly normal English. A test notices.
 *
 * Scanning whole files rather than only string literals is deliberate: it
 * also catches a comment that would teach the next person the wrong register,
 * and the cost of the stricter rule is that a phrase must be reworded rather
 * than argued about.
 */

const FORBIDDEN = [/you have to/i, /you must/i, /you should/i, /you need to/i];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every offence in one string, as "phrase" plus the line it is on. */
function offences(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const rx of FORBIDDEN) {
      if (rx.test(line)) out.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

describe("the interface does not boss anybody (AC18)", () => {
  it("finds no controlling phrase anywhere in src/", async () => {
    const files = await sourceFiles(path.join(process.cwd(), "src"));
    expect(files.length, "the scan must actually be reading files").toBeGreaterThan(5);

    const bad: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const hit of offences(text)) {
        bad.push(`${path.relative(process.cwd(), file)} — ${hit}`);
      }
    }
    expect(bad, `Reword these. A job can be dull and still get done; it does not help to order anybody about.\n${bad.join("\n")}`).toEqual([]);
  });

  it("reports a controlling phrase when there is one, so the guard is known to bite", async () => {
    // Against a literal rather than a temporary edit to src/, so both halves
    // of this criterion stay re-runnable and nothing has to be reverted.
    const sample = [
      `<p>Nothing of your own left. Nice one.</p>`,
      `<button>You have to finish the kitchen first</button>`,
      `<span>You should tidy your room</span>`,
    ].join("\n");

    expect(offences(sample)).toHaveLength(2);
    expect(offences(sample)[0]).toContain("You have to finish the kitchen");
    expect(offences("Nothing of your own left. Nice one.")).toEqual([]);
  });
});
