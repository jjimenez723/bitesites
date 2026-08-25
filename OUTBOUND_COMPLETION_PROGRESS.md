# Outbound completion — progress log

Working document for `OUTBOUND_COMPLETION_GOAL_SPEC.md`. One short entry per
checkpoint: what changed, what proves it, what is left, and who is blocking.

**Branch:** `feat/outbound-readiness-closeout`
**Baseline commit:** `925697f9b62711decaf46c37d4e76e9b5026d060` (`main`)

Unrelated uncommitted work was present on `main` at branch time and is being
left alone: admin-UI accessibility edits across `src/admin/` plus the untracked
`src/admin/row-activate.js`, and a `.claude/settings.json` permission entry.
None of it is committed by this workstream.

---

## Checkpoint 0 — baseline

**Changes:** Branch created. No code touched yet.

**Evidence:** `npm run test:all` run from the pre-existing `node_modules` on a
machine where the Firebase CLI happens to be installed globally
(`/opt/homebrew/bin/firebase`). Result recorded in checkpoint 1.

**Findings that set the work up:**

- `firebase` is not a dependency of any of the three packages, but 20 of the
  test scripts invoke `firebase emulators:exec`. CI installs only from the
  lockfiles, so `Outbound AI CI` fails at the first emulator test with
  `firebase: not found`. This is an environment failure, not an application
  failure — the suite has never reached a verdict in CI.
- No `🚧 IN PROGRESS` markers anywhere in the repo; no other agent's work is
  in flight.

**Remaining:** milestones 1–8.

**Blockers:** none at this checkpoint.

---

## Checkpoint 1 — CI and repository guardrails (milestone 1)

**Changes:**

- `firebase-tools@15.28.1` pinned as a root devDependency. Twenty test scripts
  shell out to `firebase emulators:exec`; nothing installed it. The CLI now
  resolves from `node_modules/.bin` on every machine that ran `npm ci`, and CI
  asserts that with `npx --no-install firebase --version` before the suite.
- `actions/setup-java@v4` (Temurin 17) added to the workflow. The Firestore and
  Auth emulators are Java programs; the runner image supplies a JDK today, and
  a pinned one means the suite does not start failing the week it stops.
- npm caching keyed on all three lockfiles; job timeout raised 30 → 45 minutes.
- An owner-action note at the top of the workflow: branch protection and a
  required `Outbound AI CI / validate` check. Repository settings were **not**
  changed — that needs the owner.
- Dependency vulnerabilities resolved to zero across all three packages via
  scoped `overrides` (`teeny-request > uuid`, `gaxios > uuid`,
  `@google-cloud/pubsub > @opentelemetry/core`). Scoped rather than global on
  purpose: a bare `uuid` override also downgrades `universal-analytics`, which
  wants a newer major than the advisory floor. `npm audit fix --force` was
  **not** used — it proposes downgrading `firebase-admin` 14 → 10 and
  `firebase-functions` 7 → 4, which is a larger break than the moderate
  advisory it closes.
- Secret scanner extended to the credential families this repository actually
  holds: Google API keys, Google OAuth refresh tokens, JWTs and HighLevel
  `pit-` tokens, Twilio account/API-key SIDs, and dotenv-shaped assignments of
  any secret name the repo owns. Two rules make it usable rather than noisy —
  an entropy filter, so `ACaaaa…` in an existing signature fixture is not a
  finding, and a path exemption for `src/`, where the Firebase web config and
  reCAPTCHA site key are public by design.

**Evidence** (clean install, this branch):

```
npm ci; npm --prefix functions ci; npm --prefix services/realtime-sideband ci
npx --no-install firebase --version   → 15.28.1
npm run secrets:check -- --all        → 352 tracked files scanned, passed
npm run test:all                      → 381 node:test assertions, 0 failed;
                                        16 emulator suites, 0 failed
npm --prefix functions run check      → passed
npm --prefix services/realtime-sideband run check → passed
exit 0
```

`npm run test:secrets` covers the new rules with 15 assertions, including that
a finding never carries the matched value into a log.

`npm audit` → 0 vulnerabilities in root, `functions/`, and
`services/realtime-sideband/`.

**Remaining:** milestones 2–8.

**Blockers:** branch protection is an owner action; nothing here is blocked on
it.
