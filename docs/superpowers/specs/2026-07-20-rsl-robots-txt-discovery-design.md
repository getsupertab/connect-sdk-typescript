# RSL robots.txt license discovery in the customer SDK

**Date:** 2026-07-20
**Repo:** `connect-sdk-typescript`
**Status:** design approved, pending implementation

## Problem

`obtainLicenseToken` resolves a merchant's RSL license by fetching
`${origin}/license.xml` directly (`fetchLicenseXml`, `src/customer.ts`). It never
consults `robots.txt`. This assumes every merchant self-hosts `/license.xml` at
their origin.

That assumption breaks for **passive / deferred-CAP merchants** — the ones who
never deploy an edge handler and serve nothing at origin. These are the primary
target of the licensing product, not an edge case.

Concrete failure: `inverse.com` (Bustle). Its `robots.txt` carries a well-formed
RSL discovery pointer:

```
License: https://rslcollective.org/attribution.xml
License: https://api-connect.supertab.co/merchants/systems/urn:stc:merchant:system:6747a2df-00aa-489b-91b4-713f0fdc8975/license.xml
```

but `https://www.inverse.com/license.xml` returns **404**. Because the SDK
hardcodes the origin path and ignores `robots.txt`, `obtainLicenseToken` fails
even though the merchant published a valid, standard-compliant pointer to an
API-hosted license.xml. This is an SDK gap, not a merchant misconfiguration.

## Goal

Make the customer SDK implement RSL discovery so an operator can obtain a token
from any correctly-configured RSL merchant — whether the license.xml is
self-hosted at origin or referenced via a `robots.txt` `License:` directive —
with no per-merchant hand-holding.

## Approach: origin-first, robots.txt on failure (A1)

Discovery order inside `fetchLicenseXml`:

1. **Cache check** — by origin (unchanged). Hit → return cached resolved XML.
2. **Origin attempt** — fetch `${origin}/license.xml`.
   - OK → use it, cache by origin, done. *This is today's behavior: self-hosting
     merchants see no change and no extra request.*
3. **Origin failure** (non-ok status or network error) → **robots.txt discovery**:
   - Fetch `${origin}/robots.txt`.
   - Parse **all** `License:` directives (treated as global; user-agent grouping
     is ignored — the RSL `License:` directive is site-level).
   - Iterate directives **in document order**. For each: fetch the referenced
     URL, parse its `<content>` blocks, and check for one whose `url` pattern
     matches the requested resource **and** carries a `server` (mint endpoint).
   - Take the **first** directive that yields such a mintable block. Cache the
     resolved XML by origin. Early-return — do not fetch remaining directives.
4. **No mintable license found** → throw a discovery-specific error (below).

### Why origin-first over robots-first

- Backward-compatible: existing self-hosting integrations are byte-for-byte
  unchanged and pay no extra `robots.txt` round-trip.
- The `robots.txt` path only engages for the passive case that's currently broken.
- Keeps request-path work minimal for the common case ("remove work from the
  request path").

### Why "first mintable block wins" for multiple directives

`inverse.com` lists two `License:` URLs. The existing selection logic already
requires a `<content>` block that matches the resource and has a `server`. The
`rslcollective.org/attribution.xml` is a free-attribution license with no mint
`server`, so it produces no mintable block and is naturally skipped; the Supertab
license wins. No new "which one is the paid license" heuristic is introduced —
"has a mintable `server` for this resource" already encodes the intent.

## Caching

Unchanged shape: the resolved license.xml is cached **by origin** with the
existing TTL. Whether it was resolved via origin or via `robots.txt`, subsequent
calls for the same origin skip discovery entirely until TTL expiry. The
`robots.txt` hop therefore happens at most once per origin per TTL.

## Error taxonomy

Three distinct, actionable errors so an operator can tell setup states apart:

- **Origin 404 + no `robots.txt` `License:` directive** → "no RSL license
  discoverable for `<origin>`" (merchant not set up for licensing).
- **Directives present but none mintable for the resource** → "merchant offers
  only non-mintable licenses for `<resource>`" (e.g. free-attribution only).
- **Self-hosted license.xml present but no matching `<content>` block** → keep the
  existing error message (unchanged path).

## robots.txt parsing

- Match lines of the form `License:` `<url>` case-insensitively on the directive
  name.
- Collect every match across the file regardless of `User-agent:` grouping.
- Trim whitespace; skip blank/comment (`#`) lines and malformed URLs.
- No full robots.txt grammar needed — only the `License:` directive is relevant.

## Testing

Unit tests with a mocked `fetch`:

1. **Origin-served** — `${origin}/license.xml` OK → used; `robots.txt` is never
   fetched (assert no such call).
2. **Origin 404 → robots directive followed** — origin 404, `robots.txt` has one
   `License:` pointing at a valid mintable license.xml → token flow resolves it.
3. **Multiple directives, first-mintable-wins** — free-attribution directive
   first, Supertab directive second → Supertab license selected; assert the
   free-attribution URL yields no mintable block.
4. **Only non-mintable offered** → discovery-specific "non-mintable" error.
5. **No `robots.txt` / no directive** → "no RSL license discoverable" error.
6. **Cache** — second call for the same origin performs no discovery fetches.

## Non-goals

- No robots-first discovery mode.
- No Supertab registry / API coupling in the SDK (keeps it protocol-generic).
- No changes to the merchant, edge handler, or backend.
- **Python / PHP SDKs:** the Python customer SDK has the same gap; mirroring is a
  **follow-up**, out of scope for this spec (TypeScript first).
