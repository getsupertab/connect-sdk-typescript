# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0]

> Adds relay-based analytics on top of 2.0.2. Note: this release also includes
> breaking API changes (see **Changed (BREAKING)**) despite the minor version.

### Added

- **Relay analytics.** The SDK can emit one analytics event per request to the
  Supertab Connect backend relay at `{baseUrl}/ingest/events`. Requests are
  authenticated with the existing merchant `apiKey` via
  `Authorization: Bearer <apiKey>`. The backend derives merchant identity from
  the API key, so the SDK sends **no merchant identifier** in the analytics
  payload.
- New `analyticsEnabled` (`boolean`, default `false`) configuration option on
  `SupertabConnectConfig` and on the Cloudflare/Fastly convenience handlers,
  toggling analytics emission.
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

### Notes

- Analytics is **off by default**. Enable it with `analyticsEnabled: true`. No
  extra credentials are required — it reuses the configured merchant `apiKey`.
- The billing `/events` path is fully isolated from analytics. Analytics is
  emitted only to the relay at `/ingest/events` and never touches billing.
- **Fail-open guarantee:** analytics can never block, slow, or alter request
  handling. Emission is fire-and-forget and all errors are swallowed.
- The relay endpoint `POST /ingest/events` is an assumed backend contract pending
  confirmation as the backend implementation is finalized.
- **CloudFront does not emit analytics.** The Lambda@Edge handler performs
  verification and enforcement only. Relay analytics is wired for Cloudflare and
  Fastly, which emit one event per request (Fastly is the primary edge target).
