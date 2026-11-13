#!/usr/bin/env node
/**
 * Fail if the built bundle carries a key that must never be published.
 *
 * This runs against `out/` — the exact directory that gets uploaded to GitHub
 * Pages. The repository is public and the site is public, so everything in
 * here is readable by anyone, forever, including from caches after a fix.
 *
 * Two different kinds of mistake are caught:
 *
 *   1. A SECRET KEY IN THE BUNDLE. A Supabase service-role key bypasses row
 *      level security completely: with it, any reader of the site gets full
 *      read and write access to the household's data. It reaches the bundle
 *      the moment someone names a variable `NEXT_PUBLIC_...` by mistake, and
 *      nothing else in the pipeline would notice.
 *
 *   2. NO KEY AT ALL. A build that never received its environment produces a
 *      site that loads, renders the sign-in form, and cannot talk to anything.
 *      That failure is silent and looks like a broken app, so the expected
 *      public key must be positively present, not merely "not wrong".
 *
 * Both legacy JWT keys (`eyJ...`, role in the payload) and the newer prefixed
 * keys (`sb_publishable_...` / `sb_secret_...`) are understood, because a
 * Supabase project may be issuing either.
 *
 *   node scripts/check-bundle-secrets.mjs [dir]
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "out");

/** A three-part token whose first two parts are base64url JSON. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** Supabase's newer prefixed keys. The secret one must never appear. */
const SECRET_PREFIXED = /\bsb_secret_[A-Za-z0-9_-]{8,}\b/g;
const PUBLISHABLE_PREFIXED = /\bsb_publishable_[A-Za-z0-9_-]{8,}\b/g;

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null; // base64url-ish but not a JWT; nothing to judge
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// Only text the browser is served. A font or image cannot carry a key in a
// form that matters, and binary noise produces false positives.
const TEXT = /\.(html|js|mjs|cjs|css|json|txt|map|webmanifest|xml)$/i;

const findings = [];
let filesScanned = 0;
let anonTokensFound = 0;
let publishableFound = 0;

for await (const file of walk(root)) {
  if (!TEXT.test(file)) continue;
  filesScanned += 1;
  const rel = path.relative(root, file);
  const source = await readFile(file, "utf8");

  for (const token of source.match(JWT) ?? []) {
    const claims = decodeJwtPayload(token);
    if (!claims) continue;
    // A Supabase API key names its role. A user's own access token also does,
    // but one of those has no business being baked into a build artifact
    // either, so the rule is the same: anon or nothing.
    if (typeof claims.role !== "string") continue;
    if (claims.role === "anon") {
      anonTokensFound += 1;
      continue;
    }
    findings.push(
      `${rel}\n    carries a key whose role is "${claims.role}". ` +
        "Only the anon key may be published.",
    );
  }

  for (const token of source.match(SECRET_PREFIXED) ?? []) {
    findings.push(
      `${rel}\n    carries ${token.slice(0, 18)}… — a Supabase SECRET key. ` +
        "It must never reach the bundle.",
    );
  }

  publishableFound += (source.match(PUBLISHABLE_PREFIXED) ?? []).length;
}

if (filesScanned === 0) {
  console.error(
    `Nothing to scan in ${root}. Run \`npm run build\` first — a check that ` +
      "silently scans an empty directory is worse than no check.\n",
  );
  process.exit(1);
}

// The build's own key must actually be in what it produced.
const expected = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (expected) {
  let present = false;
  for await (const file of walk(root)) {
    if (!TEXT.test(file)) continue;
    if ((await readFile(file, "utf8")).includes(expected)) {
      present = true;
      break;
    }
  }
  if (!present) {
    findings.push(
      "the configured NEXT_PUBLIC_SUPABASE_ANON_KEY is nowhere in the build.\n" +
        "    The site would load and then be unable to reach Supabase at all.",
    );
  }
} else if (anonTokensFound === 0 && publishableFound === 0) {
  findings.push(
    "no Supabase public key is present and none was configured.\n" +
      "    This build cannot talk to a backend. Set " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY before building for deployment.",
  );
}

if (findings.length > 0) {
  console.error(
    `Bundle check FAILED for ${root}\n\n` +
      findings.map((f) => `  ${f}`).join("\n\n") +
      "\n\nThis directory is published to a public URL. Treat anything found " +
      "here\nas already disclosed: rotate the key, do not merely remove it.\n",
  );
  process.exit(1);
}

console.log(
  `Bundle check passed: ${filesScanned} files, ` +
    `${anonTokensFound + publishableFound} public key reference(s), ` +
    "no secret keys.",
);
