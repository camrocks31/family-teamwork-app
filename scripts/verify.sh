#!/usr/bin/env bash
#
# Every required check, in CI's order, failing loudly.
#
# This exists because I twice pushed a commit whose checks had not passed. The
# first time a script ran `git commit` unconditionally; the second time the
# checks were gated with `set -e`, but a command piped into `grep` reports
# GREP's exit status, so a failing test suite looked like a success.
#
# Hence: pipefail, explicit status capture, and no pipes around anything whose
# result matters.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '%-28s' "$1"; }
ok()   { printf 'pass\n'; }

step "rollback round trip";  npm run db:down   >/dev/null 2>&1 || fail "reverse migrations"; ok
npx supabase db reset >/dev/null 2>&1 || fail "migrations + seed"
step "migrations + seed";    ok

step "lint";                 npm run lint      >/dev/null 2>&1 || fail "lint"; ok
step "typecheck";            npm run typecheck >/dev/null 2>&1 || fail "typecheck"; ok
step "build (static export)";npm run build     >/dev/null 2>&1 || fail "build"; ok
step "no server-only code";  node scripts/check-static-export.mjs >/dev/null 2>&1 || fail "export guard"; ok
step "database tests";       npm test          >/dev/null 2>&1 || fail "database tests"; ok
step "browser tests";        npm run test:e2e  >/dev/null 2>&1 || fail "browser tests"; ok

printf '\n\033[32mAll required checks passed.\033[0m\n'
