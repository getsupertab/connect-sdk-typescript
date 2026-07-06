# Handoff — Fastly capture fixes (SDK + edge + verification)

**For:** a session with access to all repos (`connect-sdk-typescript`,
`terraform-fastly-supertab-co`, `supertab-connect`, `tinybird`).
**Date:** 2026-07-06. **Author:** prior SDK-only session.

## Goal

Fix wrong/polluted capture-v2 analytics signals on Fastly and ship it via a beta
release, then verify against prod Tinybird. The SDK-side work is done (uncommitted on a
branch); the edge-side work and release/verification remain.

Background analysis (read these — they hold the evidence and rationale):
- `supertab-connect/docs/analytics/fastly-capture-fixes.md` — prod-data evidence + fix list.
- `connect-sdk-typescript/docs/fastly-handler-pass-event-followup.md` — FetchEvent refactor.
- `connect-sdk-typescript/docs/STC-697-fastly-analytics-delivery-followup.md` — emit keep-alive.

---

## The core problem (one cause)

supertab.co runs Fastly as a **VCL service → Compute service chain** (`route_to_compute`
in `terraform-fastly-supertab-co`). This is **strategic, not incidental**: most SDK users
are VCL-fronted, and the upcoming **Content Guard** feature requires exposing signals as
VCL headers passed to Compute.

Behind that chain, `event.client.*` in the downstream Compute service is the **upstream
Fastly hop**, not the viewer. So prod rows showed:
- `request_asn` = `54113` (Fastly's own AS) ~100%
- `client_ip` = Fastly IP ranges
- `request_country` = POP country
- `header_names` polluted with edge-injected headers (`cdn-loop`, `x-varnish`, …)

The real viewer IP is only in the **`Fastly-Client-IP`** header (it persists across Fastly
hops). Country/ASN must be derived from *that* IP.

---

## Design decisions (already made — don't relitigate without reason)

1. **Simplest possible interface: no new SDK option / no topology flag.** The SDK decides
   by **header presence**: `Fastly-Client-IP` present → chained path; absent → compute-only.
2. **Chained path** (header present): use header IP; derive country/ASN via
   `fastly:geolocation.getGeolocationForIpAddress()`; **JA3 = null** (the hop's TLS is not
   the viewer's, and there's no viewer JA3 on this path).
3. **Compute-only path** (header absent): use `event.client.{address, geo, tlsJA3MD5}` — the
   real, unspoofable connection info.
4. **Spoofing tradeoff, accepted:** on a *pure compute-only* deployment a client can spoof
   `Fastly-Client-IP`. Impact is limited to polluting the attacker's own analytics row (IP
   is never used for enforcement). Chained deployments must harden the header at the VCL
   edge (see remaining work #2). This tradeoff was chosen deliberately for interface
   simplicity over a config flag + auto-detect.

---

## SDK state — `connect-sdk-typescript`

Branch: **`feat/fastly-handler-fetchevent`** (off `main`). SDK version still `2.1.0` — **no
bump yet**.

**Committed (2 commits ahead of main):**
- `543b6d4` — `fastlyHandleRequests` first arg is now the Fastly `FetchEvent` (was
  `event.request`). Dropped `clientIp`/`requestCountry`/`requestAsn` from
  `FastlyHandlerOptions`. Added exported `FastlyFetchEvent`/`FastlyClientInfo`/
  `FastlyGeolocation` types. **Breaking signature change.**
- `18afb9a` — bridges `FetchEvent.waitUntil` into the analytics `ExecutionContext` and
  threads it through `handleFastlyRequest` → `handleRequest`, so post-response emits (esp.
  the BLOCK path) aren't dropped at instance teardown (STC-697 option B). Both Fastly
  transports already honored `ctx.waitUntil`, so no transport change was needed.

**Uncommitted (the capture fix itself — needs committing):**
- `src/index.ts` — `resolveFastlyClientSignals(event)` helper (the header-vs-event logic
  above), `@internal`-exported for tests, wired into `fastlyHandleRequests`.
- `src/fastly.d.ts` — `fastly:geolocation` ambient module declaration.
- `src/analytics/buildAnalyticsEvent.ts` — strip-list extended with portable proxy headers:
  `cdn-loop`, `x-varnish`, `via`, `surrogate-key`, `surrogate-control` (fixes `header_names`
  pollution). **Deployment-specific** headers (`x-geoip-country-code`, `x-ua-device`,
  `x-lp-*`) are NOT strippable by a portable SDK — fix those at the edge (see below).
- `tests/fastly-client-signals.test.ts` (new) + `tests/analytics/buildAnalyticsEvent.test.ts`
  (strip-list coverage). Full suite: **171 passing, 14 skipped.** `npm run build` clean.

Notes: `dist/` is committed in this repo — rebuild (`npm run build`) and commit it with
`src/`. The public `.d.ts` is unchanged by the uncommitted work (no API change;
`resolveFastlyClientSignals` is stripped via `@internal` + `stripInternal`).

---

## Remaining work

### 1. Edge entrypoint — new SDK signature  (`terraform-fastly-supertab-co/app/src/index.js`)
Currently calls the **old** signature and will not compile against the new SDK:
```js
// CURRENT (broken against new SDK):
SupertabConnect.fastlyHandleRequests(event.request, merchantApiKey, ORIGIN_BACKEND, {
  ..., clientIp: event.client.address, requestCountry: geo?.country_code ?? null,
  requestAsn: geo?.as_number ?? null, logEndpoint: "bot_events",
});
```
Change to: pass **`event`** (not `event.request`) and **remove** `clientIp`/`requestCountry`/
`requestAsn` (those options were dropped — the SDK sources them internally now):
```js
SupertabConnect.fastlyHandleRequests(event, merchantApiKey, ORIGIN_BACKEND, {
  enableRSL, merchantSystemUrn, analyticsEnabled, logEndpoint: "bot_events",
});
```

### 2. VCL hardening — make `Fastly-Client-IP` trustworthy on the chain
In the VCL entry service's `vcl_recv` (Terraform templates: `recv_pre_macro.vcl.tftpl` /
`recv_post_macro.vcl.tftpl`), set the header from the real connection IP so a client can't
spoof it before it reaches Compute:
```vcl
set req.http.Fastly-Client-IP = client.ip;
```
This is the same header-injection mechanism Content Guard will use. **Confirm** the chain
actually forwards the header to the Compute backend (chain configs vary). Reference:
Fastly docs — Fastly-Client-IP is client-spoofable unless reset at the trusted edge.

### 3. (Optional, edge) stop injecting deployment-specific headers
`x-geoip-country-code`, `x-ua-device`, `x-lp-*` are injected by supertab's own upstream
Fastly service and pollute `header_names`. Either stop injecting them before the Compute
handler, or strip them in VCL. The portable SDK can't know these by name.

### 4. Commit + beta release (SDK)
Commit the uncommitted SDK work first. Then follow the **manual beta recipe** (do NOT use CI
publish — it mis-tags prereleases as `latest`; see `connect-sdk-typescript/CLAUDE.md`):
`npm version 2.1.0-beta.N --no-git-tag-version` → CHANGELOG entry →
`npm ci && npm run build && npm test` → `grep -c 2.1.0-beta.N dist/index.js dist/index.cjs`
→ commit `package.json` + `CHANGELOG.md` + `dist/` → **Hassaan runs `npm publish --tag beta`**
(publishing is done by him). Then bump the beta dep in `terraform-fastly-supertab-co` and
`terraform apply` (Hassaan runs this).

> ⚠️ This is a **breaking** signature change. Whether the beta version stays in the `2.1.x`
> line or moves to `3.0.0` is Hassaan's call — confirm before publishing.

### 5. Verify against prod Tinybird
Scope to rows written **after deploy**. Use `tinybird/bin/tbq prod "<SQL>"`.
```
URN = urn:stc:merchant:system:7ed96375-20df-4aa4-afd7-af2d0d9c1ca1
WHERE merchant_system_urn = '<URN>' AND timestamp > '<DEPLOY_TS>'
```
| # | Check | Before (broken) | After (fixed) |
|---|---|---|---|
| 1 | `uniqExact(request_asn), topK(5)(request_asn)` | 1 distinct, `[54113]` | many ASNs; 54113 not dominant |
| 2 | `topK(10)(client_ip)` | Fastly ranges (`23.235.*`, `140.248.*`, `157.52.*`, `167.82.*`) | varied real client IPs |
| 3 | `uniqExact(client_ip) ips, count() rows` | ips ≪ rows | ips scales with real diversity |
| 4 | `arrayJoin(header_names) h, count() GROUP BY h` | contains `cdn-loop`, `x-varnish`, `x-geoip-*`, `x-ua-device`, `x-lp-*` | only client headers |
| 5 | `round(avg(length(header_names)),1)` | ~11.9 / ~17.8 | ~4–6 fewer |

**Cross-check (independent of DB):** hit the site through a VPN in a known country and
confirm the row's `request_country` matches the VPN country (catches country-masking
directly). Or use a throwaway Fastly test service + test URN to avoid mixing with live data.

---

## Out of scope here (downstream, after capture is trusted)
Tinybird pipe / dashboard reclassification (`tinybird/lib/dashboard_pipes.py`) — the spoof
heuristic leans on Cloudflare-only signals dead on Fastly; rework to use `accept-language`
presence + `header_names` fingerprint. Also curl `scraper`→`scanner`, and folding declared
crawlers into `bot_ua_patterns`. See the last section of `fastly-capture-fixes.md`.

## Open questions for Hassaan
- Beta version line: `2.1.0-beta.N` vs a `3.0.0` prerelease (breaking change).
- Confirm the chain forwards `Fastly-Client-IP` to the Compute backend.
- Whether to also address deployment-specific header injection (#3) now or later.
