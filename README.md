# Our Family Hub

A private coordination app for one household: what needs doing, who did it, and
whether the things the children want to do are actually available yet.

It is a statically exported Next.js app served from GitHub Pages, with Supabase
behind it. There is **no application server** — every rule that has to be true
is enforced in Postgres.

## Why there is no server

The site is static files on a public host, so the browser bundle is readable and
modifiable by anyone. Nothing in it is trusted:

- **Postgres `SECURITY DEFINER` functions** own every state change, its
  authority check and its attribution.
- **Supabase Edge Functions** handle photo ingest (format and size checks,
  re-encode, EXIF strip) and signed-URL issuance.
- **Row level security** is on for every table, and the published bundle carries
  only the anon key — public by design, and useless without a policy that lets
  it see a row.

What stops server code creeping in is **`scripts/check-static-export.mjs`**, a
source scan that runs in CI and fails on route handlers, middleware, server
actions, `next/headers`, `next/server` or `force-dynamic`.

It is a scan rather than a build check for a measured reason: with Next 16.4.6,
`output: "export"` does **not** fail the build on any of those, even though the
docs list them as unsupported. They build, deploy, and then silently do nothing
— GitHub Pages serves files, it does not run code. A quiet failure is worse
than a loud one, so the scan is the guard.

## Privacy

This repository is public, because free GitHub Pages requires it. So:

- The committed seed carries **structure only** — "Parent One",
  "Children's Bedroom". A test enforces this with an allowlist.
- The household's real names live in `supabase/seed.local.sql`, which is
  gitignored. Copy `supabase/seed.local.example.sql` to create it.
- No secrets are committed. The service-role key is used only by local scripts.

## Getting started

Requires Node 24, npm and Docker.

```bash
npm install
npm run db:start          # local Supabase (first run pulls several GB)
npm run db:reset          # migrations + the generic seed
npm run db:seed:local     # optional: your household's real names
```

Then copy `.env.local.example` to `.env.local` and fill it in — `npx supabase
status` prints the URL and keys. Create the first parent account:

```bash
npm run bootstrap:parent -- --member "Parent One"
```

There is deliberately **no sign-up page**. The app is on a public URL, so a
sign-up form would let anyone create an account against the household. Parents
are created by the script above and then invite each other; children never have
logins — they select a profile and enter a PIN on an enrolled device.

```bash
npm run dev               # development
npm run build             # static export into out/
npm run preview           # serve the export, as GitHub Pages would
```

## Checks

```bash
npm run lint
npm run typecheck
npm run build
npm test                  # unit + integration, against real Postgres
npm run test:e2e          # Playwright, against the built export
npm run db:down           # reverse every migration, then db:reset to restore
```

Integration tests run against the real database rather than mocks, because
every invariant they check is a database constraint — a mock would prove
nothing. The end-to-end tests run against the built static export rather than
the dev server, because that is the artifact that gets deployed.

## Design decisions worth knowing

- **Readiness is derived, never stored.** Whether an activity is available is
  computed from task rows at call time by `evaluate_activity_readiness`. There
  is one implementation, in Postgres; the client asks and never recomputes.
- **A definition owns its occurrence mode; a requirement item owns its
  evaluation scope.** Shared tasks produce one household instance per day;
  per-member tasks produce one each. Composite foreign keys hold the two in
  agreement, so one child's bedroom can never satisfy another's.
- **Editing a task does not rewrite history.** Edits create a new immutable
  revision, and each dated instance pins the revision it was created under.
- **Adult-shared bedrooms do not gate the children's activities.** They have
  their own daily tasks, but an adult's tidying is never the reason a child
  cannot watch TV.

Delivery is tracked in Linear under the "Our Family Hub" project.
