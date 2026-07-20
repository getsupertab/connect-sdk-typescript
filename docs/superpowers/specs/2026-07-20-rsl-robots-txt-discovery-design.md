# RSL robots.txt license discovery in the customer SDK

**Date:** 2026-07-20
**Repo:** `connect-sdk-typescript`
**Status:** implemented (branch `feat/rsl-robots-discovery`)

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
     URL and classify it for the resource via the shared `selectMintableContent`
     (see Provider disambiguation): `supertab` (a mintable block whose `server`
     host matches the configured Supertab base), `other` (a mintable block on a
     different host), or `none`.
   - **Prefer Supertab:** return the first `supertab` directive immediately
     (early-return). Hold the first `other` directive as a fallback and keep
     looking. If no `supertab` directive appears, return the held fallback.
     Cache the resolved XML by origin.
4. **No mintable license found** (every directive `none`) → throw a
   discovery-specific error (below).

### Why origin-first over robots-first

- Backward-compatible: existing self-hosting integrations are byte-for-byte
  unchanged and pay no extra `robots.txt` round-trip.
- The `robots.txt` path only engages for the passive case that's currently broken.
- Keeps request-path work minimal for the common case ("remove work from the
  request path").

## Provider disambiguation (multiple mintable directives)

`inverse.com` lists two `License:` URLs, and — verified against live data — **both**
resolve to a `<content>` block with a `server`:

- `rslcollective.org/attribution.xml` → `server="https://api.rslcollective.org"`
  (free attribution).
- The Supertab-hosted `license.xml` → `server="https://api-connect.supertab.co/urn:…"`
  (the paid one this SDK holds credentials for).

So "first block with a `server` wins" is wrong: document order picks rslcollective,
and `obtainLicenseToken` would then POST the operator's Supertab `clientId:clientSecret`
to `api.rslcollective.org/token` — wrong license **and** a credential leak to a third
party. (An earlier draft of this spec wrongly assumed the attribution license had no
`server`; live inspection disproved it.)

**Rule — prefer Supertab among candidates:** among server-bearing blocks matching the
resource, prefer those whose `server` host equals the configured Supertab base host
(`SupertabConnect.baseUrl`, default `https://api-connect.supertab.co`, overridable);
fall back to all server-bearing blocks only when none match. This is a *preference*,
not a hard restriction — a merchant advertising a single non-Supertab provider is still
honored (deliberate; keeps single-provider behavior unchanged). A shared
`selectMintableContent` implements this and is used by **both** the discovery gate and
the mint path, so discovery can never resolve a license the mint path would then reject.

**Why not hard-restrict to Supertab?** RSL is an open standard, and this SDK's token flow
is deliberately RSL-generic: a bot may legitimately use it to obtain a token from *any*
RSL-compliant provider, not only Supertab. Hard-restricting the mint `server` to the
Supertab host would break that. The residual credential-exposure concern (posting client
credentials to a sole non-Supertab token endpoint) is the accepted cost of staying
standard-generic; the Supertab-host *preference* still ensures that whenever a Supertab
license is on offer, that is what gets used. (Reviewed and chosen over always-restrict.)

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
