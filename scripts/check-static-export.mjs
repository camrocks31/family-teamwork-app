#!/usr/bin/env node
/**
 * Fail if server-only code has crept into a repository that ships as a static
 * export.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A BUILD CHECK
 *
 * The first version of this script planted a dynamic route handler and asserted
 * that `next build` failed. It appeared to pass — but only because an unrelated
 * TypeScript error was failing the build at the time. Once that was fixed, the
 * truth came out: with Next 16.4.6 and `output: "export"`, a route handler that
 * reads Request, a page calling `cookies()`, and a server action ALL build
 * without error, despite the installed docs listing them as unsupported.
 *
 * That is worse than a loud failure. Such code builds, deploys to GitHub Pages,
 * and then simply does not work — there is no server to run it. So the guard
 * cannot be "the build will catch it". This scan is the guard.
 *
 * Checked against: node_modules/next/dist/docs/01-app/02-guides/static-exports.md
 * (the "Unsupported Features" list), verified empirically on 2026-11-13.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOTS = ["src", "app", "pages"];

/** Each rule: why it cannot work without a server. */
const CONTENT_RULES = [
  {
    // Not anchored to the start of a line: the directive is just as valid
    // inside a function body as at the top of a file, and the first version of
    // this rule missed exactly that case.
    pattern: /["']use server["']/,
    what: "a server action (\"use server\")",
    why: "server actions post back to a server; there is none.",
  },
  {
    pattern: /from\s+["']next\/headers["']/,
    what: "an import from next/headers",
    why: "cookies() and headers() read a request that never reaches a server.",
  },
  {
    pattern: /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/,
    what: "export const dynamic = \"force-dynamic\"",
    why: "a statically exported page cannot be rendered per request.",
  },
  {
    pattern: /from\s+["']next\/server["']/,
    what: "an import from next/server",
    why: "NextRequest/NextResponse only exist in a server runtime.",
  },
];

/** Files that cannot exist at all. */
const FORBIDDEN_BASENAMES = new Map([
  ["route.ts", "a Route Handler"],
  ["route.tsx", "a Route Handler"],
  ["route.js", "a Route Handler"],
  ["middleware.ts", "middleware"],
  ["middleware.js", "middleware"],
  ["proxy.ts", "a proxy"],
]);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // root does not exist in this project; fine
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

const findings = [];

for (const root of ROOTS) {
  for await (const file of walk(path.join(process.cwd(), root))) {
    const rel = path.relative(process.cwd(), file);
    const base = path.basename(file);

    const forbidden = FORBIDDEN_BASENAMES.get(base);
    if (forbidden) {
      findings.push(
        `${rel}\n    is ${forbidden}, which needs a server at request time.`,
      );
      continue;
    }

    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(base)) continue;
    const source = await readFile(file, "utf8");
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(source)) {
        findings.push(`${rel}\n    contains ${rule.what} — ${rule.why}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(
    "Server-only code found in a statically exported app.\n\n" +
      findings.map((f) => `  ${f}`).join("\n\n") +
      "\n\nThis would build and deploy, and then silently not work: GitHub Pages\n" +
      "serves files, it does not run code. Anything that must be trusted or\n" +
      "run on a server belongs in a Postgres SECURITY DEFINER function or a\n" +
      "Supabase Edge Function instead. See HAL-1538 §2.4.\n",
  );
  process.exit(1);
}

console.log(
  "No server-only code found: no route handlers, middleware, server actions, " +
    "next/headers or next/server imports.",
);
