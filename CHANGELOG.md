# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0-beta.1] — Capture v2 signals + Fastly native logging

> Additive analytics enrichment on top of `2.1.0-beta.0`. Analytics events now
> bump to `schema_version: 2` and carry richer spoof-detection signals, and
> Fastly gains a native-logging delivery path. No breaking API changes;
> classification stays query-time in the warehouse (the SDK emits raw signals
> only). Requires the relay (Phase 2) and Tinybird schema (Phase 1) to be
> deployed first — older producers stay valid.

### Added

- **Fastly native logging transport** (`FastlyLogTransport`). Fastly can now
  deliver analytics through a named Fastly real-time logging endpoint
  (`fastly:logger` → S3 → Tinybird) instead of the HTTP relay, keeping the
  per-request event firehose off the backend. Enable it on `fastlyHandleRequests`
  by passing `logEndpoint` together with `merchantSystemUrn` (required so rows
  can be stamped with merchant identity, since there's no backend to derive it on
  this path); without `logEndpoint`, Fastly analytics falls back to the HTTP
  relay. Cloudflare/CloudFront are unaffected.
- **Portable header signals** (every CDN, read from request headers):
  `sec_fetch_mode` / `_site` / `_dest` / `_user`, `sec_ch_ua` / `_mobile` /
  `_platform`, `accept`, `host`, `has_cookies` (presence only, never the value),
  and `header_names` — a lowercased, deduped, sorted set with edge-injected
  headers (`cf-*`, `x-forwarded-*`, `x-real-ip`) stripped.
- **Query-string derived signals** computed at the edge — `query_length`,
  `query_param_count`, `query_suspicious` (mechanical exploit-marker match). The
  raw query string is never stored.
- **Cloudflare `request.cf` plumbing**: `accept_encoding`
  (`cf.clientAcceptEncoding`, not the rewritten header), `http_protocol`,
  `tls_version`, `tls_cipher`, `tls_client_hello_length` (parsed string→int),
  `tls_client_extensions_sha1`, `as_organization`, `client_tcp_rtt`,
  `cdn_verified_bot_category`, `request_priority`. `tls_fingerprint_ja4` is
  defined but null until a zone reaches Enterprise.
- **Fastly**: maps the header-exposed signals (`accept_encoding`, JA4); the rest
  are null. **CloudFront** is unchanged (still emits no analytics).
- `accept`, `sec_ch_ua` and `as_organization` are truncated to 512 chars at the
  edge as a defense against junk-header senders.

### Changed

- Analytics events now emit `schema_version: 2`. Fail-open is preserved at every
  layer — signal extraction never throws into the request path.

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
