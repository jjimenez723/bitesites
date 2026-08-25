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

Verify the deployment rather than trusting it:

```bash
npm run smoke:staging                 # anonymous probes: deployed, and guarded
npm run smoke:staging -- --with-admin # also a disposable admin and one real call
```

Two traps worth knowing before the next deploy:

- **Every `defineString` parameter needs a value in the dotenv file for a
  non-interactive deploy, even one with a default.** `PAID_PHONE_SCREENING` is
  set in the staging dotenv but is **not** in `functions/.env.bitesites-org`, so
  the next production deploy will fail until `PAID_PHONE_SCREENING=disabled` is
  added there.
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

Staging is deployed: Firestore rules and indexes, 120+ Functions, and Hosting at
<https://bitesites-outbound-staging.web.app>. Billing is linked; the project has
its own inert placeholder secrets and no production credential.

Verify it with the smoke test rather than by reading a deploy log:

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

### A deploy trap worth knowing

Firebase's non-interactive deploy demands a value for **every** `defineString`
parameter, including ones with a default. Adding `PAID_PHONE_SCREENING` broke
the staging deploy until it was written into
`functions/.env.bitesites-outbound-staging`. The production dotenv
(`functions/.env.bitesites-org`) needs the same key —
`PAID_PHONE_SCREENING=disabled` — before the next production deploy, or it will
fail the same way.

## Decisions still required

- Authorize a billing account for the dedicated staging project so Gen-2
  Functions can be packaged and deployed.
- Choose whether stage needs a separate, non-production Twilio subaccount. Do
  not copy production credentials into staging.
- Choose calendar test identities/calendars and named internal test callers.
- Approve a staging deployment. This repository change has not deployed,
  provisioned, called, or unpaused anything.
