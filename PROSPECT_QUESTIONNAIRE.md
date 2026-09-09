# Prospect questionnaire and lead-email intent

## Public route and storage

The post-conversation questionnaire is available at `/questionnaire?token=…`.
The token is 256 random bits. Only its SHA-256 hash is used as the
`questionnaireSessions/{hash}` document ID; no lead ID or CRM context appears
in the URL.

An admin creates or reuses a 30-day session through
`createQuestionnaireSession`. The public `getQuestionnaireSession` callable
returns only safe prefill fields: first name, business name, website, and
location. `submitQuestionnaire` validates an exact field allowlist, controlled
choices, lengths, HTTPS links, and the token on the server. A completed session
is idempotent and cannot be overwritten.

Answers are stored in `questionnaireResponses/{sessionHash}` and copied into
`leads/{leadId}.questionnaire.answers` for the Leads panel. The lead also keeps
the status (`ready`, `sent`, or `completed`), link, expiry, and timestamps.
Firestore rules allow admins to read session/response records but deny every
client-side write and every public read. No questionnaire action sends a
customer email automatically.

## Customer-email intent

Lead `source` remains acquisition provenance. Customer lifecycle email is
controlled separately by `emailLifecycle`:

- `inbound_inquiry` + `initiatedBy: recipient` + an allowlisted channel may
  receive `lead_received`.
- `outbound_prospect` never receives an inquiry receipt.
- `booking` receives its appointment confirmation, not an inquiry receipt.

The allowlisted receipt combinations are the website intake form, Bit chat,
and BiteSites' visitor-initiated Byte web or inbound-phone experience. GoHighLevel contact imports,
outbound campaign promotions, manual qualification, admin follow-up-created
contacts, and unclassified voice records fail closed and do not receive an
inquiry receipt.

## Follow-up links

Admin follow-ups now submit an ordered `actions` array with up to eight items:

```js
{ label: 'Complete the quick questionnaire', url: 'https://…', kind: 'questionnaire' }
```

`kind` is one of `questionnaire`, `booking`, `website`, `meeting`, or `custom`.
Labels and URLs are validated server-side. The first action is the primary
button, the second is a secondary button, and later actions are supporting text
links. Every action is also emitted in the plain-text body. Legacy `none`,
`confirmed`, and `self_schedule` inputs are normalized into this model.

## Deployment

Deploy Functions and Firestore rules together with the hosting build. No new
Firestore index or secret is required. `PUBLIC_APP_URL` must remain configured
for the target environment so generated questionnaire links use the correct
origin.
