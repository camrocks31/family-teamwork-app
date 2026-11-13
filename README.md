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

## Deployment

The site is a static export on **GitHub Pages**, and the backend is a hosted
**Supabase** project. There is nothing else to pay for and nothing to keep
running.

Live at **https://camrocks31.github.io/family-teamwork-app/**

### How a deploy happens

Every push to `main` runs the full check suite. The deploy job declares
`needs: check`, so it cannot start unless every check on that same commit
passed — a red build never publishes. It then builds a *second* time with the
base path set (a project site is served from `/<repo>/`, not from the root),
scans the output for leaked keys, and uploads it to Pages. The last step asks
the published URL for itself, because a deployment can report success and
still serve a 404.

Re-deploy without a new commit from the Actions tab: run the **CI** workflow
by hand.

### One-time setup

**1. Repository variables** — Settings → Secrets and variables → Actions →
*Variables*. Both are public by design: they ship inside the bundle that
anyone can read from the published site.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | your project URL, e.g. `https://abcdef.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the project's anon / publishable key |
| `PAGES_BASE_PATH` | optional; defaults to `/<repo-name>`, which is right for a project site |

They are *variables*, not secrets, for two reasons: they are published either
way, and GitHub masks secrets in logs — which would blind the very check that
looks for them in the build output.

The **service-role key must never** be a repository variable or a
`NEXT_PUBLIC_` anything. It bypasses row level security completely. It belongs
in your local `.env.local` and in Edge Function secrets, nowhere else.

**2. Pages source** — Settings → Pages → Source: **GitHub Actions**.

**2a. Supabase auth settings.** These are deliberately *not* taken from
`supabase/config.toml`: that file configures the local development stack, and
pushing it whole would carry a dozen unrelated settings into production —
measured, it would disable email confirmations, drop the email rate limit from
a minute to a second, shorten OTPs and turn off MFA enrolment.

Set them in the dashboard, or push a **minimal** config that declares only
what you mean to change (undeclared properties are left alone):

```bash
mkdir -p /tmp/cfg/supabase && cat > /tmp/cfg/supabase/config.toml <<'EOF'
project_id = "family-teamwork-app"
[auth]
site_url = "https://<user>.github.io/<repo>"
additional_redirect_urls = ["https://<user>.github.io/<repo>/**"]
EOF
npx supabase config diff --remote=<ref> --workdir /tmp/cfg
npx supabase config push --remote=<ref> --workdir /tmp/cfg --yes
```

| Setting | Value | Why |
| --- | --- | --- |
| Authentication → URL Configuration → Site URL | the deployed site | Supabase builds the links in its emails from this, so a reset link is useless if it is wrong |
| Authentication → URL Configuration → Redirect URLs | `<site>/**` | Supabase refuses to redirect anywhere unlisted, which is what makes the reset page reachable |
| Authentication → Sign In / Providers → Email → Allow new users to sign up | **off** | The app is on a public URL. Left on, anyone in the world can create an account against this household's backend |

Password reset relies on Supabase sending email. The built-in sender is rate
limited and intended for testing; configure your own SMTP before relying on
it.

**3. Push the schema** to the hosted project:

```bash
npx supabase login                       # or export SUPABASE_ACCESS_TOKEN
npx supabase link --project-ref <ref>    # the subdomain of your project URL
npx supabase db push                     # applies every migration in order
```

**4. Seed it, and create the first account.** The committed seed is
placeholders only — never household data, because this repository is public:

```bash
psql "$DATABASE_URL" -f supabase/seed.sql
psql "$DATABASE_URL" -f supabase/seed.local.sql      # your real names, gitignored

BOOTSTRAP_ALLOW_REMOTE=yes npm run bootstrap:parent -- --member "Parent One"
```

`bootstrap-parent` refuses to run against anything but a local stack unless
`BOOTSTRAP_ALLOW_REMOTE=yes` is set, because it holds the service-role key and
a stray `.env` should not be able to reach a real household.

### If something is wrong

| Symptom | Cause |
| --- | --- |
| Deploy fails: "Repository variable … is not set" | step 1 above, not yet done |
| Site loads, sign-in does nothing | the anon key did not reach the build; the bundle check should have caught it |
| Styles and scripts 404 | base path mismatch — `PAGES_BASE_PATH` must match the repo name |
| Signs in, then shows no household | the member row is not linked to your account, or the schema was never pushed |

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
