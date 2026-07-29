# Canonical-domain redirects

`https://bitesites.org` is the canonical public website. Cloudflare performs the
redirects below at the edge, before traffic can reach an origin.

| Incoming hostname | HTTP and HTTPS behavior |
| --- | --- |
| `www.bitesites.org` | 301 to `https://bitesites.org` |
| `bytesites.org`, `www.bytesites.org` | 301 to `https://bitesites.org` |
| `bitsites.org`, `www.bitsites.org` | 301 to `https://bitesites.org` |

Each redirect uses `concat("https://bitesites.org", http.request.uri.path)` and
preserves the original query string. For example,
`https://www.bytesites.org/contact?source=email` redirects to
`https://bitesites.org/contact?source=email`.

## Cloudflare configuration

All records below are proxied (orange-cloud) so Single Redirects can run.

| Zone | DNS record | Purpose |
| --- | --- | --- |
| `bitesites.org` | Existing apex A `199.36.158.100` | Firebase Hosting; retained unchanged |
| `bitesites.org` | `www` A `199.36.158.100` | Enables the canonical redirect |
| `bytesites.org` | Apex A `192.0.2.1`; `www` CNAME to apex | Placeholder origin used only to enable edge redirects; this domain is not configured in Firebase Hosting |
| `bitsites.org` | Apex A `192.0.2.1`; `www` CNAME to apex | Placeholder origin used only to enable edge redirects; this domain is not configured in Firebase Hosting |

The redirect rules are isolated zone-level `http_request_dynamic_redirect` rulesets:

| Zone | Ruleset ID | Rule ID |
| --- | --- | --- |
| `bitesites.org` | `14ea41346fc34ae385fab67e09030667` | `f2e873f9478349f395d558eb6a5334fc` |
| `bytesites.org` | `5277d273eff34fccb9cba4b300be7bdc` | `ec11f563507d41cea82b2be4c7fc95fd` |
| `bitsites.org` | `753bc2f8038d4c98a2ab2adff7f1a4a6` | `00d9d3b1e0dd4282893cea814ab3f74a` |

Do not remove or modify the existing MX, TXT, DKIM, DMARC, SPF, Firebase
verification, ACME challenge, n8n, Postmark, or email-routing records while changing
this setup.

## Verify

Run this without following redirects; it should return `301` and the exact `Location`
value shown below.

```bash
curl -sS -o /dev/null -D - 'https://www.bytesites.org/contact?source=email' \
  | grep -iE '^(HTTP|location:)'
# HTTP/... 301
# location: https://bitesites.org/contact?source=email
```

Also confirm the canonical site still serves normally:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://bitesites.org/
# 200
```

## Rollback

If all redirects must be removed, delete these DNS records first, then the matching
rulesets. This leaves the original Firebase apex record intact.

| DNS record | Record ID |
| --- | --- |
| `www.bitesites.org` A | `bb79a01b14d084de56a7de9b99f87a1d` |
| `bytesites.org` A | `0e262e894baadaa19c8442b86d50e1db` |
| `www.bytesites.org` CNAME | `f8f293f812207d1b672556bb68e3466d` |
| `bitsites.org` A | `e3c7e67ec18df4650ab31229d63f5a93` |
| `www.bitsites.org` CNAME | `70ba51d06739eed89aa895367140db1a` |

The ruleset IDs in the configuration table are the three rollback targets.
