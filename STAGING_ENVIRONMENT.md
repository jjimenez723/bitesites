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

The project is intentionally not linked to billing. Firebase therefore refuses
to package/deploy Gen-2 Functions until an owner authorizes a billing account.
No carrier, OpenAI, calendar, or production secret has been copied into it.

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

## Decisions still required

- Authorize a billing account for the dedicated staging project so Gen-2
  Functions can be packaged and deployed.
- Choose whether stage needs a separate, non-production Twilio subaccount. Do
  not copy production credentials into staging.
- Choose calendar test identities/calendars and named internal test callers.
- Approve a staging deployment. This repository change has not deployed,
  provisioned, called, or unpaused anything.
