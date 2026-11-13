#!/usr/bin/env node
/**
 * HAL-1539 acceptance criterion 1, second half.
 *
 * "The build fails on a route handler, middleware or server action" is a claim
 * about a guard, and a guard nobody tests is a guard nobody knows works. This
 * script temporarily adds a dynamic route handler, runs the build, and asserts
 * it fails — then removes it again.
 *
 * It matters because the whole security model rests on it: with no application
 * server, every trusted decision must live in Supabase. If server code could
 * creep into this repo and quietly build, the thing enforcing that would be
 * nothing but a reviewer's attention.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const GUARD_DIR = path.join(process.cwd(), "src", "app", "__export_guard__");
const GUARD_FILE = path.join(GUARD_DIR, "route.ts");

const OFFENDING_ROUTE = `// Temporary file written by scripts/check-static-export.mjs.
// A route handler that reads the request cannot be statically exported.
export async function GET(request: Request) {
  const who = request.headers.get("x-who") ?? "nobody";
  return new Response(JSON.stringify({ who }), {
    headers: { "content-type": "application/json" },
  });
}
`;

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["next", "build"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

let failed = false;
try {
  await mkdir(GUARD_DIR, { recursive: true });
  await writeFile(GUARD_FILE, OFFENDING_ROUTE, "utf8");

  console.log("Added a dynamic route handler; the build must now fail.");
  const { code, output } = await runBuild();

  if (code === 0) {
    console.error(
      "\nFAIL: the build SUCCEEDED with a dynamic route handler present.\n" +
        "output: 'export' is not actually guarding this repository, so server " +
        "code could ship without anyone noticing. Check next.config.ts.",
    );
    failed = true;
  } else {
    const reason = output
      .split("\n")
      .filter((l) => /export|route|static|dynamic/i.test(l))
      .slice(0, 4)
      .join("\n  ");
    console.log(`\nPASS: the build failed as required (exit ${code}).`);
    if (reason) console.log(`  ${reason}`);
  }
} finally {
  await rm(GUARD_DIR, { recursive: true, force: true });
  console.log("Removed the temporary route handler.");
}

process.exit(failed ? 1 : 0);
