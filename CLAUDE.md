# Working agreements

This repository is worked on by more than one agent, often across sessions that
cannot see each other. Two conventions exist because of that. Both are cheap to
follow and expensive to skip.

## 1. Claim a piece of the plan before you start it

The plan documents are the shared surface. Before you begin work on an item in
one, mark it — in the same document, next to the item, before your first code
change. Not after, and not in a commit message nobody will read while the work
is still in flight.

The marker is one line, greppable, and visible in rendered Markdown:

```markdown
> **🚧 IN PROGRESS** — 2026-08-24 — campaign circuit breaker — `functions/campaign-circuit-breaker.js`, `functions/outbound-calls.js`
```

Date it, name the scope, and list the files you expect to touch. When the work
lands, **delete the marker in the same commit that finishes it**. A marker left
behind is worse than no marker, because the next agent will trust it.

Find every claim in the repo with:

```bash
grep -rn "🚧 IN PROGRESS" --include="*.md" . --exclude=CLAUDE.md
```

The `--exclude` matters: this file is the only place the marker format is
written out, so without it every search returns these examples. Define the
format here and nowhere else, and the search stays clean.

**If you find a marker you did not write**, do not assume the work is done or
abandoned. Check the worktree first — `git status --short`, `git log --oneline -5`,
`git diff` — because the previous session may have stopped mid-change with
uncommitted edits. Reconcile what you find before touching those files. Do not
discard another agent's uncommitted work to make room for your own; read it,
finish it, or ask.

A marker older than a few days with no matching commits is probably abandoned.
Verify with git rather than assuming, then either finish it or remove it and say
so.

## 2. Documentation is part of the change, not a follow-up

If a change makes a document wrong, the document is fixed in the same commit.
A plan that describes behavior the code no longer has is not documentation; it
is a trap, and the next agent will act on it.

This applies in both directions:

- **Code that outgrows a doc.** Shipping a safety control means updating the
  document that says it is missing. Renaming a CI workflow means updating the
  doc that names the old one.
- **Docs that outgrow the code.** If a document promises something the code does
  not do, either build it or mark it clearly as not built. `OUTBOUND_PRODUCTION_READINESS.md`
  separates "what is implemented locally" from "external launch blockers" for
  exactly this reason — keep that line honest.

Say what is actually true, including when it is unflattering: what was verified,
what was skipped, what is blocked and on whom. A readiness document that reads
as finished when it is not is the single most dangerous artifact in this repo,
because the gates in `OUTBOUND_LAUNCH_AUTHORIZATION.md` are decided from it.

## Where the plan lives

Read these before changing outbound behavior:

| Document | What it governs |
|---|---|
| `OUTBOUND_HANDOFF.md` | Plain-language: what this system is and why it has not called anyone |
| `OUTBOUND_OWNER_CHECKLIST.md` | The six stages on one page, and which one we are actually on |
| `AI_VOICE_CONSENT_v1.md` | The disclosure wording people sign, and what turns a signature into a grant |
| `OUTBOUND_FIRST_CALL_RUNBOOK.md` | The ten-call internal rehearsal, in order, with the deploy sequence |
| `OUTBOUND_PRODUCTION_READINESS.md` | What is built, what is not, and the quality gates |
| `OUTBOUND_LAUNCH_AUTHORIZATION.md` | Owner decisions already made, and the authorizations still required |
| `STAGING_ENVIRONMENT.md` | The non-dialing staging project and how to deploy it |
| `AI_SALES_PLATFORM_ARCHITECTURE.md` | Seller isolation, runtime and tool boundaries |
| `HYBRID_DIALER_DEPLOYMENT.md` | Carrier/dialer deployment specifics |

## Safety rules that outrank convenience

These are not style preferences. Full detail is in the two outbound documents
above; the short version, because an agent that only reads this file still must
not get these wrong:

- Do not unpause a production campaign, place an external call, or deploy to
  production without explicit authorization for that specific action.
- Watcher-Leads and Byte-Dialer records carry **no** verified AI-voice consent.
  Imported consent-like text is evidence, never permission.
- Recording stays off unless separately consented after the call is answered.
- The three sellers — BiteSites, Stone Bellisimo, The Fine Line Group — never
  share identity, consent, research, offers, calendars, or reporting.
- Prefer a server-enforced invariant over a prompt-only instruction. Treat UI
  state as a view of backend truth, never as the authority.
