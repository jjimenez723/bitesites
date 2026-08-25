# Non-dialing staging environment

Staging is a separate Firebase/GCP project used to validate Firebase rules,
callable APIs, appointment behavior, research, tool execution, and frontend
flows. It is **not** an authorization to call anyone.

The runtime admits an external carrier-backed call only when both conditions
are true:

1. `BITESITES_DEPLOYMENT_ENVIRONMENT=production`
2. `OUTBOUND_EXTERNAL_DIALING=enabled`

Every other environment, including `staging`, is fail-closed. This applies
before a campaign can lock a target, warm the media sideband, enroll a provider
workflow, or create a Twilio PSTN/SIP call. Mock calls remain available to the
test suite.

## Provisioned staging project

The dedicated project is `bitesites-outbound-staging`, with Hosting origin
`https://bitesites-outbound-staging.web.app`. Firebase is enabled and its
default Firestore database is provisioned in `nam5`, matching production.
The local ignored staging config and public web SDK config point only to this
project. Staging builds use Vite's `staging` mode and preflight refuses a
production Firebase project or auth domain.

**Billing was authorized and linked on 2026-08-24, and the stack is deployed.**
Rules, indexes, Functions and Hosting are live; Firebase Auth is initialised so
the smoke test can provision a disposable admin. No carrier, OpenAI, calendar,
or production secret has been copied into it — the 23 secrets that exist are
inert placeholders, so a staging function that reaches a vendor fails
authentication rather than acting.

Verify the deployment rather than trusting it — see **Deployed state** below
for the commands and what each one actually proves.

Three traps worth knowing before the next deploy:

- **Every `defineString` parameter needs a value in the dotenv file for a
  non-interactive deploy, even one with a default.** Adding
  `PAID_PHONE_SCREENING` broke the staging deploy until it was written into
  `functions/.env.bitesites-outbound-staging`. It has since been added to
  `functions/.env.bitesites-org` as well, so the production dotenv no longer
  fails on it.
- **A production deploy switches on whatever that dotenv says, and nobody
  reviews it.** `functions/.env.bitesites-org` is untracked and local: it never
  appears in a diff, in CI, or in a pull request, and on 2026-08-25 it was
  found holding `OUTBOUND_EXTERNAL_DIALING=enabled` — the flag every readiness
  document describes as disabled. The deployed production runtime predates the
  parameter, so the documents were true about production and false about the
  file that would replace it. Run `npm run preflight:production` before any
  production Functions deploy; it prints the three policy parameters and exits
  non-zero when one of them is open without its matching authorization.
- **A Firebase deploy can exit non-zero after succeeding.** The Artifact
  Registry cleanup-policy step runs last, and its failure aborts the run after
  Functions deployed but before Hosting released. Read the log, not the exit
  code alone.

## One-time local configuration

Do not reuse `bitesites-org`, a production Hosting origin, Twilio credentials,
or a production Cloud Run service.

```bash
# config/environments/staging.json and .env.staging are already configured
# locally and are ignored by Git.
npm run configure:staging -- --write
npm run preflight:staging
```

`staging.json` and the generated `functions/.env.<staging-project-id>` are
ignored by Git. Neither file holds secrets. Configure stage-specific Firebase
secrets manually in the staging project only when a test truly needs them.

## Safe checks and deployment

```bash
npm run test:staging-infra
npm run dry-run:staging
```

The dry-run is read-only but does contact Firebase to validate the chosen
staging project. A real deployment requires a deliberate project-id
confirmation and never falls back to production:

```bash
npm run deploy:staging -- --confirm-staging-deploy=YOUR_STAGING_PROJECT_ID
```

The staging helper deploys Firebase rules, indexes, Functions, and Hosting. It
does not deploy Cloud Run or provision secrets. A future stage sideband must
use a separately named Cloud Run service, stage-only secrets, and the staging
Hosting control URLs. Its outbound media path will still be blocked by the
runtime gate above.

## Deployed state

Rules, indexes, 120+ Functions and Hosting are live at
<https://bitesites-outbound-staging.web.app>. Verify that with the smoke test
rather than by reading a deploy log — a green deploy log describes what was
uploaded, not what answers:

```bash
npm run smoke:staging                 # anonymous probes, no writes
npm run smoke:staging -- --with-admin # also provisions a disposable admin
```

It checks four separate claims: every guarded callable is reachable and refuses
an anonymous caller; the **deployed** runtime reports a non-production
environment with external dialing disabled and paid screening off — read from
the live function's own configuration, not from the local file that produced it;
an admin can reach what an admin should; and, with `--with-admin`, the
disposable user and its role document are removed again afterwards.

The smoke test earned its place immediately: it caught two callables returning
404 because they had been written after the last deploy, which a green deploy
log cannot tell you.

### One-time Auth setup already applied

Firebase Auth had never been initialised in the staging project, so
`createUser` failed with `CONFIGURATION_NOT_FOUND`. Applied once:

```bash
TOKEN=$(gcloud auth application-default print-access-token)
curl -X POST "https://identitytoolkit.googleapis.com/v2/projects/bitesites-outbound-staging/identityPlatform:initializeAuth" \
  -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: bitesites-outbound-staging" \
  -H "Content-Type: application/json" -d '{}'

curl -X PATCH "https://identitytoolkit.googleapis.com/v2/projects/bitesites-outbound-staging/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" \
  -H "Authorization: Bearer $TOKEN" -H "X-Goog-User-Project: bitesites-outbound-staging" \
  -H "Content-Type: application/json" -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}}}'
```

The `X-Goog-User-Project` header is required: local ADC has no quota project and
the API refuses the call without it.

## Decisions still required

Billing and the staging deployment were both **granted and completed on
2026-08-24** and are no longer open questions — see
[OUTBOUND_LAUNCH_AUTHORIZATION.md](./OUTBOUND_LAUNCH_AUTHORIZATION.md) §1 and
§2. What remains open about staging specifically:

- **Rollback has never been rehearsed.** The deploy has been done; undoing it
  has not. Nothing is known about how long it takes or what breaks halfway.
- Whether staging needs a separate, non-production Twilio subaccount. Do not
  copy production credentials into staging; the 23 secrets there are inert
  placeholders and a staging function that reaches a vendor should fail
  authentication rather than act.
- Which calendars and test identities staging books against, and which named
  internal callers may take part in a rehearsal.

Approving any of these does **not** approve a production deploy, an external
call, or unpausing a campaign. Those are separate decisions and are recorded
separately.
