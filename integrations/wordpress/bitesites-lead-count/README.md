# BiteSites Lead Count (WordPress plugin)

A single-file plugin for a client WordPress site (pilot: cliftonaveanimalhospital.com)
that lets BiteSites read **how many** leads the site received in a billing month, so the
monthly invoice can bill "Lead Generation — N leads × $75.00". It returns counts only;
no lead's name, email or phone number ever leaves the site.

**Status: written and tested locally, not installed anywhere.** Installing it on the live
CAAH site goes through that site's own deployment gates (backup, review, deploy).

## What it reads

`{prefix}caah_leads` — the first-party lead table the CAAH theme writes
(`inc/caah-lead-capture.php`) and the Team View lead queue reads. Rows created in
`[start, end)` — midnights in America/New_York (override with `BITESITES_LEADS_BILLING_TZ`), converted to the site clock that `created_at` uses — are counted after Team View's two rules:

1. test/evaluation rows are excluded (email contains `.invalid`, or the name contains
   `test` or `eval`);
2. repeat submissions are collapsed when they share a normalized name, email or phone
   (transitively), within the requested range.

## Endpoint

```http
GET /wp-json/bitesites/v1/lead-count?start=2026-11-01&end=2026-12-01
X-BiteSites-Secret: <secret>
```

```json
{ "count": 12, "total_rows": 15, "excluded_test": 1, "duplicates": 2,
  "start": "2026-11-01", "end": "2026-12-01", "end_exclusive": true,
  "timezone": "America/New_York", "rule": "team_view_operational_v1" }
```

Errors: `401` wrong/missing secret, `403` plain HTTP, `503` not configured or no lead
table, `400` bad range (max 93 days). Responses are `Cache-Control: no-store`.

## Install (when authorized)

1. Generate a secret (at least 24 characters), e.g. `openssl rand -hex 32`.
2. Store it in BiteSites: `firebase functions:secrets:set WP_LEADS_SECRET`.
3. Add it to the site's `wp-config.php`:
   `define('BITESITES_LEADS_SECRET', '<the same value>');`
4. Upload `bitesites-lead-count.php` to `wp-content/plugins/bitesites-lead-count/`
   (or `wp-content/mu-plugins/` to make it always-on) and activate it.
5. Check it: `curl -H "X-BiteSites-Secret: …" "https://cliftonaveanimalhospital.com/wp-json/bitesites/v1/lead-count?start=2026-11-01&end=2026-12-01"`
   and compare the count with Team View for the same month.
6. In BiteSites **Admin → Billing**, the CAAH client's lead source is
   `https://cliftonaveanimalhospital.com/wp-json/bitesites/v1/lead-count`.

If the endpoint is unreachable at month end the invoice simply stays a draft with an
empty lead count; an admin can retry the pull or type the number in.

## Test

```bash
php integrations/wordpress/bitesites-lead-count/tests/lead-count.test.php
```
