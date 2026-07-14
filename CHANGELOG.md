# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.2] — 2026-07-14

### Added

- **`analyticsBaseUrl` config option, plus `SupertabConnect.setAnalyticsBaseUrl()` /
  `getAnalyticsBaseUrl()`.** Points the analytics ingest relay at a specific host,
  independent of `setBaseUrl` (which stays the base for token acquisition / JWKS /
  verification). Mirrors the existing `baseUrl` pattern.

### Changed

- **Analytics now defaults to the dedicated ingest service
  (`https://ingest-connect.supertab.co`)** rather than the API host. Only affects
  deployments with `analyticsEnabled: true`; the `/ingest/events` path and payload are
  unchanged — traffic just moves to the standalone service. Non-prod / local setups
  should call `setAnalyticsBaseUrl()` (as the demos now do) to avoid emitting to prod.

## [2.2.1] — 2026-07-13

### Added

- **`component` identity in the `/.well-known/supertab/status` payload.** The
  self-report body now includes `component: { kind: "ts-sdk", version }` so
  the backend can resolve the correct version-update registry per
  integration. Additive, backward-compatible.

### Removed

- **`sdkVersion` from the `/status` payload.** Redundant with
  `component.version` for the TS SDK (identical value). The backend reads
  `component`; the legacy `sdkVersion`-only shim still covers already-deployed
  2.1.0 builds.

## [2.2.0] — 2026-07-09

> Fixes wrong/polluted capture-v2 signals on Fastly service-chain deployments
> (e.g. a VCL service fronting Compute), where `event.client.*` is the upstream
> Fastly hop rather than the viewer. **Breaking**: `fastlyHandleRequests` now
> takes the `FetchEvent`.

### Changed

- **`fastlyHandleRequests(event, ...)` now takes the Fastly `FetchEvent`** (was
  `event.request`), and the `clientIp` / `requestCountry` / `requestAsn` handler
  options are removed — the SDK sources these internally. **Breaking.**

### Fixed

- **Viewer IP/geo/ASN on the Fastly service chain.** The SDK now reads the real
  client from the `Fastly-Client-IP` header (preserved across Fastly hops) and
  derives country/ASN via `fastly:geolocation`, falling back to `event.client.*`
  on non-chained deployments. Previously chained rows recorded the Fastly hop
  (`request_asn` = Fastly's AS, `client_ip` = a Fastly range, `request_country`
  = the POP). JA3 is null on the chained path (the hop's TLS is not the viewer's).
- **`header_names` pollution.** The strip-list now covers portable proxy
  artifacts (`cdn-loop`, `x-varnish`, `via`, `surrogate-key`, `surrogate-control`).
  Deployment-specific injected headers must still be stripped at the edge.

## [2.1.0] — 2026-07-06

> Relay-based analytics, richer edge signals, a self-report status endpoint, and
> Fastly native logging, on top of 2.0.2. **Includes breaking API changes**
> (see Migration) despite the minor version. Analytics is off by default and
> fail-open; classification stays query-time in the warehouse — the SDK emits
> raw signals only.

### Added

- **Relay analytics.** One analytics event per request to the Supertab Connect
  relay at `{baseUrl}/ingest/events`, authenticated with the merchant `apiKey`
  (`Authorization: Bearer <apiKey>`); the backend derives merchant identity, so
  no merchant identifier is sent in the payload. Off by default — enable with
  `analyticsEnabled: true` on `SupertabConnectConfig` or the Cloudflare/Fastly
  handlers. Wired for Cloudflare and Fastly (Fastly is the primary edge target);
  CloudFront does not emit analytics.
- **Capture-v2 signals (`schema_version: 2`).** Events now carry richer
  spoof-detection signals, all fail-open:
  - Portable header signals (every CDN): `sec_fetch_*`, `sec_ch_ua*`, `accept`,
    `accept_language`, `host`, `has_cookies` (presence only, never the value),
    and `header_names` (lowercased, deduped, sorted; `cf-*` / `x-forwarded-*` /
    `x-real-ip` stripped).
  - Query-derived signals computed at the edge: `query_length`,
    `query_param_count`, `query_suspicious`. The raw query string is never stored.
  - Cloudflare `request.cf` plumbing: `accept_encoding` (`cf.clientAcceptEncoding`,
    not the rewritten header), `http_protocol`, `tls_version`, `tls_cipher`,
    `tls_client_hello_length` (parsed string→int), `tls_client_extensions_sha1`,
    `as_organization`, `client_tcp_rtt`, `cdn_verified_bot_category`,
    `request_priority`; `tls_fingerprint_ja4` defined but null until a zone
    reaches Enterprise.
  - Fastly maps its header-exposed signals (`accept_encoding`, JA4); the rest null.
  - `accept`, `sec_ch_ua`, and `as_organization` truncated to 512 chars at the edge.
- **Self-report status endpoint.** The SDK serves `GET /.well-known/supertab/status`.
  A request with a valid backend-minted ES256 challenge (`Authorization: Bearer`,
  `purpose: "status-probe"`, `aud` = the request origin, ~60s expiry) gets the
  SDK's live config back — `{ runtime, sdkVersion, enforcement, eventReporting }`;
  anything else gets a minimal `{ "supertab": true }` 404. Both set
  `Cache-Control: no-store`. It short-circuits at the top of `handleRequest`,
  before token verification, bot detection, and analytics, so a probe never looks
  like traffic or emits an event. Challenge verification reuses the platform JWKS
  the SDK already fetches for license tokens. Served across all three runtimes via
  a new `HandlerAction.RESPOND`.
- **Fastly native logging transport (`FastlyLogTransport`).** Deliver analytics
  through a named Fastly real-time logging endpoint (`fastly:logger` → S3 →
  Tinybird) instead of the HTTP relay, keeping the per-request event firehose off
  the backend. Enable by passing `logEndpoint` + `merchantSystemUrn` to
  `fastlyHandleRequests`; without `logEndpoint`, Fastly analytics falls back to
  the HTTP relay. Cloudflare/CloudFront unaffected.
- **Fastly Compute client IP & geo.** `FastlyHandlerOptions` accepts `clientIp`,
  `requestCountry`, and `requestAsn` — on Compute these live on the `FetchEvent`
  (`event.client.*`), not request headers, so without them analytics rows had an
  empty `client_ip` and null geo. Pass them from `event.client`; VCL services fall
  back to headers and are unaffected.
- **Token-outcome / final-action analytics.** Events record a `tokenOutcome`
  (`absent` · `malformed` · `not_validated` · `valid`) and `finalAction`
  (`allow` · `block` · `observe`), including a `not_validated`/`allow` row for
  `DISABLED` mode.
- **New public API:** `EnforcementMode.OBSERVE` / `ENFORCE`, `HandlerAction.RESPOND`,
  `SDK_VERSION`, `selectFastlyAnalyticsTransport`, and the `AnalyticsEvent` /
  `AnalyticsTransport` types.

### Changed (BREAKING)

- `EnforcementMode` renamed: `SOFT` → `OBSERVE`, `STRICT` → `ENFORCE` — both the
  enum keys **and** their string values (`"soft"` → `"observe"`, `"strict"` →
  `"enforce"`).
- `handleRequest`'s second argument is now a `HandleRequestContext` object,
  previously a bare `ExecutionContext`.
- The default `enforcement` is now `OBSERVE` (the renamed former default `SOFT`) —
  a rename, not a behavior change.

### Fixed

- **Silent Fastly transport fallback.** Passing `logEndpoint` / `merchantSystemUrn`
  to the `SupertabConnect` constructor was silently ignored (those belong on
  `fastlyHandleRequests`). The constructor now warns, and
  `selectFastlyAnalyticsTransport` is exported so JS consumers can wire the Fastly
  transport manually.
- `source_cdn` may now be `null` in analytics/request contexts rather than being
  forced to a value.

### Migration from 2.0.x

1. **Rename enforcement modes** — keys and string values both changed:
   ```ts
   // Before (2.0.x)          →   // After (2.1.0)
   EnforcementMode.STRICT     →   EnforcementMode.ENFORCE   // "strict" → "enforce" (blocking)
   EnforcementMode.SOFT       →   EnforcementMode.OBSERVE   // "soft"   → "observe" (observe-only)
   ```
   Update any config that sets enforcement from a raw string too. Default behavior
   is unchanged (still observe-only) — only the name changed.

2. **`handleRequest` second argument.** This is the generic integration path — a
   plain server, self-hosted, or any CDN other than the three with built-in
   wrappers (Cloudflare/Fastly/CloudFront handle it for you). If you passed an
   `ExecutionContext` positionally, wrap it:
   ```ts
   // Before
   sdk.handleRequest(request, ctx);
   // After — the ExecutionContext moves inside a context object
   sdk.handleRequest(request, { ctx });
   ```
   If you passed no second argument, nothing changes. You can now also pass
   `clientIp` / `requestCountry` / `requestAsn` / `sourceCdn` / `cdnSignals` in
   that object to populate analytics the SDK can't derive on its own off a
   non-CDN runtime.

### Notes

- **Fail-open:** analytics can never block, slow, or alter request handling —
  emission is fire-and-forget and all errors are swallowed.
- Analytics is off by default; enabling it requires no extra credentials (reuses
  the merchant `apiKey`). The billing `/events` path is fully isolated — analytics
  only ever hits `/ingest/events`.
- **CloudFront** performs verification/enforcement only and emits no analytics.
