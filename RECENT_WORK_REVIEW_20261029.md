# Recent BiteSites work and live status — October 29, 2026

This review compares current GitHub main (`579a662`), actual Firebase releases
and deployed function source, live pages, and the older shared workspace.
Dates below are Eastern time. Repository changes are distinguished from live
configuration; an old verification note alone is not evidence of today's state.

## David's issue — resolved today

David is the approved BiteSites rep using `alexander555yunda@gmail.com`.
October 28 introduced mandatory AI sales practice and campaign-assignment
requirements. David had neither a training exemption nor an assigned campaign.
Exemption support reached the backend earlier October 29, but the live page and
Firestore rules were still the previous release.

Today's fix completes the page/rules rollout, waives practice for David's
BiteSites account, and assigns him to **Local Business Website Growth — August
2026**, the original live campaign. It showed 94 ready prospects during the
check. His simulator is hidden; old training bookmarks lead to the human dialer.
An additional rules defect rejecting assigned-campaign list queries is repaired.
Other representatives' exemptions and assignments were not changed.

David should reload https://bitesites.org/admin/outbound?tab=dialer and press
**Start dialing**, allowing microphone access if prompted. These are real human
calls, one at a time. No call was placed while making or testing this change.

## Changes in the latest releases

| Date | Work | Verified status |
| --- | --- | --- |
| October 27 | Standardized prospect categories and added tools to match existing CRM contacts using read-only GoHighLevel requests. | Merged to main. This audit did not run a production backfill. |
| October 27 | Fixed recovery after a Twilio browser phone device is destroyed; improved reconnect handling and mobile call status. | Included in the current frontend. |
| October 27 | Added manager-controlled campaign assignments and rep display-name editing. | Live. David had no campaign assignment until today's fix. |
| October 27 | Human call wrap-up now holds the next call until an outcome is saved. Interested calls pause for a composed follow-up email, with send/skip and explicit resume. | Live frontend and backend. |
| October 28 | Re-enabled the human dialer's external-calling settings after the prior release left them disabled. | All six relevant human-call functions remain enabled. |
| October 28 | Added mandatory three-scenario AI sales role-play for each seller, scoring, and default-campaign assignment after completion. | Live; this was David's simulator blocker. |
| October 28 | Fixed a missing hash import in training status and limited rep warm-transfer reads to assigned campaigns. | Live. |
| Earlier October 29 | Added per-rep, per-seller training exemptions and admin controls. Redeployed training endpoints with the missing-import fix. | Backend was already live when this task began. Downloaded training function sources match current main. Page and rules rollout were incomplete. No real role-play was exercised in this audit. |
| Today, 4:41–4:42 PM | Completed exemption rollout, repaired campaign query permissions, hid practice for exempt reps, and restored David's original campaign access. | Published and verified. Browser/access checks pass. |

## Earlier work preserved locally, but absent from the current frontend

There is deployment drift. The original working directory is based on September
23 and contains extensive uncommitted work. Its October verification notes
record releases that are no longer reflected in the latest main/Hosting build.
Today's release preserves the current live site's public pages and assets.

- **October 8–9 marketing work:** revenue-systems positioning, a five-step
  project intake with a Custom AI option, five service pages, a dedicated FAQ,
  expanded search metadata, prerendered content, holographic cards, and molten
  backgrounds. The source is preserved in the original workspace. Current main
  does not include these additions; the live `/faq` still renders the older
  homepage rather than the dedicated FAQ.
- **October 15–16 dialer work:** dedicated Interested/Call Back Later folders,
  phone-number history search, consented recording controls/playback, and
  additional audio-start optimizations. Those implementations remain in the
  original workspace; the current frontend does not contain those added folders,
  phone search, or recording UI. Regular History, notes, and Call Later remain.
- **Other local work:** email mailbox/search/reply features, quick-message
  composition, expanded questionnaire work, and Jonathan's external booking
  option. The original workspace contains these changes. Their complete live
  state was not independently verified here, so they are not reported as newly
  deployed by this task.
- **Search Console:** the original setup document still records an October 17
  access-related open item. No Search Console repair was performed here.

These older files were preserved. Deploying that entire old workspace would
replace newer access and dialer changes; restoring individual features requires
reconciling them with current main.

## Verification and source

Build, focused browser checks, existing dialer browser checks, nine training
tests, 42 dialer tests, and the new real-rules/session access test passed. The
full rules suite has the same four existing fixture failures on baseline and
patched code (167 passes in each run). Production audio still requires David's
own answered call; none was initiated automatically.

Hosting release: `dedd7bc8db4e450e`. The custom domain and Firebase origin serve
the tested entry/admin bundles, and deployed rules match the tested file. The
six human-call functions retained their revisions and enabled settings.

Implementation and detailed evidence:
[REP_LIVE_DIALER_RESTORATION.md](REP_LIVE_DIALER_RESTORATION.md).
Source branch: `codex/restore-rep-live-dialer`, isolated checkout at
`/Users/cesaryunda/Bitesites3.0/bitesites-rep-live-dialer`.
