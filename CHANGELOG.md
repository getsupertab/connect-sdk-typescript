# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-29

### Added

- **Tinybird analytics emission.** New `buildAnalyticsEvent`,
  `HttpAnalyticsTransport`, `NoopAnalyticsTransport`, and supporting types
  (`AnalyticsEvent`, `AnalyticsTransport`, `BotVerdict`, `Decision`) under
  `src/analytics/`. Events are shaped to match the Tinybird `bot_events_raw`
  datasource and emitted on every request branch (allow / observe / block).
- New `SupertabConnectConfig` fields: `analyticsEnabled`, `analyticsToken`,
  `analyticsEndpoint`, `analyticsTransport` (DI hook for tests / custom
  transports).
- New `Env.SUPERTAB_ANALYTICS_TOKEN` and `Env.MERCHANT_ID` for Cloudflare
  Workers.
- New `analyticsEnabled` / `analyticsToken` / `analyticsEndpoint` options on
  `cloudflareHandleRequests`, `fastlyHandleRequests`, `cloudfrontHandleRequests`.
- Per-request `request_id` (`crypto.randomUUID()`) generated inside
  `handleRequest` and stamped onto analytics events.
- `source_cdn` stamped per CDN entry handler (`cloudflare` / `fastly` /
  `cloudfront`).
- `client_ip` extracted per CDN (Cloudflare `cf-connecting-ip`, Fastly
  `fastly-client-ip`, CloudFront `event.Records[0].cf.request.clientIp`)
  and normalized to IPv6 (IPv4 is mapped as `::ffff:a.b.c.d`; missing or
  invalid IPs serialize as `::`).

### Changed (BREAKING)

- **`EnforcementMode` renamed.** `SOFT` → `OBSERVE`, `STRICT` → `ENFORCE`.
  `DISABLED` is unchanged.
- **`EnforcementMode` string values changed.** The enum's underlying string
  values changed alongside the keys: `"soft"` → `"observe"`, `"strict"` →
  `"enforce"`. Any code that passes the *raw string* (e.g. `enforcement:
  "soft"`) instead of the imported enum (e.g.
  `enforcement: EnforcementMode.OBSERVE`) will silently fall back to the
  default (`OBSERVE`). Search your config sources — including secret stores,
  Worker environment variables, and Fastly config — for raw `"soft"` or
  `"strict"` values and update them.
- **`HandlerAction` is now three-state**: `ALLOW | OBSERVE | BLOCK`. Previously
  the soft-mode signal path returned `ALLOW` with extra headers; it now
  returns `OBSERVE` with the same headers. Any code that switches on
  `HandlerAction` must add an `OBSERVE` branch (or treat it like `ALLOW`).
- **`BotDetector` return type changed.** Previously `(req, ctx?) => boolean`.
  Now `(req, ctx?) => BotVerdict`, where `BotVerdict` is one of `'human' |
  'unverified_bot' | 'suspicious' | 'unknown' | 'verified_bot'`. Custom
  detectors must be updated. The `'verified_bot'` slot is reserved for
  server-side verification (CAP, HTTP message signatures) and is unreachable
  from `defaultBotDetector` in v1.
- **`SupertabConnect.handleRequest` signature changed.** Second argument is
  now an optional `HandleRequestContext` object (`{ ctx?, sourceCdn,
  clientIp?, requestId? }`) instead of a bare `ExecutionContext`. Direct
  callers (not going through the CDN convenience methods) must update.
- **Default `enforcement` value** is `EnforcementMode.OBSERVE` (renamed from
  `SOFT`); behavior is unchanged.
- **New required `merchantId` config field.** `SupertabConnectConfig` now
  requires `merchantId: string` in addition to `apiKey`. The merchantId is
  the stable identifier stamped on analytics events; the apiKey remains a
  rotatable credential. Previously the SDK reused `apiKey` as the analytics
  merchant_id, which meant rotating a key orphaned all prior analytics rows.
  All three CDN entry points now require it: Cloudflare reads it from
  `env.MERCHANT_ID`; Fastly and CloudFront accept it on their `options`
  object as `merchantId`. The constructor throws if missing.
- **`fastlyHandleRequests` `options` parameter is now required** (it was
  optional). `merchantId` lives on the options object, so the parameter can
  no longer be omitted.

### Notes

- The billing path (`recordEvent` / `verifyAndRecordEvent` posting to
  `/events`) is fully isolated from analytics emission. Analytics failures
  cannot affect billable event recording.
- Analytics is off by default. Enable per-instance with `analyticsEnabled:
  true` and an `analyticsToken`. If `analyticsEnabled` is true but
  `analyticsToken` is missing, the SDK logs a warning at construction time
  (once, not per request) and falls back to a no-op transport.
- Default analytics endpoint is the Tinybird `europe-west2` region. Override
  via `analyticsEndpoint` if your workspace lives elsewhere.

## [1.4.1] - prior

See git history for changes prior to v2.0.0.
