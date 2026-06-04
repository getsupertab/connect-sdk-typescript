# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0]

> Adds relay-based analytics on top of 2.0.2. Note: this release also includes
> breaking API changes (see **Changed (BREAKING)**) despite the minor version.

### Added

- **Relay analytics.** The SDK can emit one analytics event per request to the
  Supertab Connect backend relay at `{baseUrl}/v1/events`. Requests are
  authenticated with the existing merchant `apiKey` via
  `Authorization: Bearer <apiKey>`. The backend derives merchant identity from
  the API key, so the SDK sends **no merchant identifier** in the analytics
  payload.
- New configuration options on `SupertabConnectConfig` (and the CDN handler
  option objects):
  - `analyticsEnabled` (`boolean`, default `false`) — toggles analytics emission.
  - `analyticsTransport` (`AnalyticsTransport`, optional) — dependency-injection
    hook for tests/custom transports.
- Pluggable `AnalyticsTransport` abstraction with `HttpAnalyticsTransport` as
  the default implementation.
- Analytics events capture `request_id`, `source_cdn`, a normalized IPv6
  `client_ip`, and the per-CDN classification signals `request_country`,
  `request_asn`, and `tls_fingerprint`, plus HTTP Message Signature headers
  (`signature_agent`, `signature_input`, `signature`) when the CDN exposes them.

### Changed (BREAKING)

- `EnforcementMode` enum renamed: `SOFT` → `OBSERVE`, `STRICT` → `ENFORCE`
  (both the enum keys **and** their string values changed).
- The default `enforcement` mode is now `OBSERVE`.
- `handleRequest`'s second argument is now a `HandleRequestContext` object
  (previously a bare `ExecutionContext`).
- `fastlyHandleRequests`' `options` parameter is now optional.

### Notes

- Analytics is **off by default**. Enable it with `analyticsEnabled: true`. No
  extra credentials are required — it reuses the configured merchant `apiKey`.
- The billing `/events` path is fully isolated from analytics. Analytics is
  emitted only to the relay at `/v1/events` and never touches billing.
- **Fail-open guarantee:** analytics can never block, slow, or alter request
  handling. Emission is fire-and-forget and all errors are swallowed.
- The relay endpoint `POST /v1/events` is an assumed backend contract pending
  confirmation as the backend implementation is finalized.
- **CloudFront analytics coverage:** the Lambda@Edge handler returns early when
  the `x-license-auth` header is absent, so analytics events are emitted only
  for token-bearing requests on CloudFront. Cloudflare and Fastly emit one event
  per request; Fastly is the primary edge target for analytics.
