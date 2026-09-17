import { EnforcementMode } from "../types";
import { normalizeClientIp, UNSPECIFIED as UNSPECIFIED_IP } from "./ip";
import {
  AnalyticsEvent,
  CdnRequestSignals,
  ClientIpSource,
  Decision,
  SCHEMA_VERSION,
  SourceCdn,
  StatusSource,
} from "./types";

export interface BuildAnalyticsEventContext {
  requestId: string;
  sourceCdn: SourceCdn | null;
  clientIp?: string | null;
  // Where clientIp came from. Omitted by callers that can't say, and stays null then —
  // provenance is asserted by whoever resolved the address, never inferred here.
  clientIpSource?: ClientIpSource | null;
  // The status of the response served, and why it is what it is. Only a caller that waited
  // for the response can supply these; one that did not says so with `unobserved` rather
  // than leaving a null nothing can interpret.
  statusCode?: number | null;
  statusSource?: StatusSource | null;
  timestamp?: Date;
  requestCountry?: string | null;
  requestAsn?: number | null;
  tlsFingerprint?: string | null;
  // CDN plumbing not derivable from the portable Request (request.cf, etc.).
  cdnSignals?: CdnRequestSignals;
}

// Defensive cap on client-controlled free-form strings, applied at the edge
// (mirrored by the relay). Documented in tinybird/docs/schema.md.
const MAX_FIELD_LENGTH = 512;

// Edge-injected headers are CDN artifacts, not client signals — strip them so
// `header_names` reflects only what the client actually sent. Covers all three
// CDNs: Cloudflare (`cf-*`), Fastly (`fastly-*`), CloudFront (`cloudfront-*`),
// the shared `x-forwarded-*` / `x-real-ip`, and the SDK's own routing headers:
// `x-original-request-url` (set by the Fastly/CloudFront handlers) and anything
// under `x-supertab-*`. The prefix is what keeps a RENAMED preserved-authority
// header out too — the builder never sees `originalAuthorityHeader`, so a custom
// name only stays out of the signal by keeping the prefix.
const EDGE_HEADER_PREFIXES = ["cf-", "fastly-", "cloudfront-", "x-forwarded-", "x-supertab-"];
// Portable proxy/CDN artifacts (incl. Fastly service-chain hops: cdn-loop, x-varnish,
// via) — not client-sent, so they pollute header_names. Deployment-specific injected
// headers (e.g. x-geoip-*, x-ua-device, x-lp-*) must be stripped at the edge instead;
// a portable SDK can't enumerate them.
const EDGE_HEADER_NAMES = new Set([
  "x-real-ip",
  "x-original-request-url",
  "cdn-loop",
  "x-varnish",
  "via",
  "surrogate-key",
  "surrogate-control",
]);

// Mechanical exploit markers for the query-string heuristic, matched case-
// insensitively against the raw and URL-decoded query. A coarse signal only —
// real classification stays query-time in the warehouse.
const SUSPICIOUS_QUERY_MARKERS = [
  "../",
  "..\\",
  "union select",
  "<script",
  "onerror=",
  "/etc/passwd",
];

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isoUtc(date: Date): string {
  return date.toISOString();
}

function truncate(value: string | null, max = MAX_FIELD_LENGTH): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

// The wrappers decide provenance from whether an address was *available*, before
// normalizeClientIp has had a chance to reject it. A malformed value (a spoofed
// Fastly-Client-IP, say) becomes the "::" sentinel, and the row would then claim a CDN
// vouched for an address that is no longer there. Reconcile the two here, the one place
// that sees both. An undeclared source stays null: only the caller knows its provenance,
// and "we have no address" is not something to assert on its behalf.
function reconcileIpSource(
  normalizedIp: string,
  declared: ClientIpSource | null | undefined
): ClientIpSource | null {
  if (declared === undefined || declared === null) return null;
  return normalizedIp === UNSPECIFIED_IP ? "absent" : declared;
}

function isEdgeHeader(name: string): boolean {
  if (EDGE_HEADER_NAMES.has(name)) return true;
  return EDGE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function collectHeaderNames(headers: Headers): string[] {
  const names = new Set<string>();
  for (const key of headers.keys()) {
    const name = key.toLowerCase();
    if (!isEdgeHeader(name)) names.add(name);
  }
  return [...names].sort();
}

interface QuerySignals {
  query_length: number | null;
  query_param_count: number | null;
  query_suspicious: boolean | null;
}

function querySignals(url: URL | null): QuerySignals {
  if (url === null) {
    return { query_length: null, query_param_count: null, query_suspicious: null };
  }
  // URL.search includes a leading "?" when non-empty.
  const raw = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const params = raw.length === 0 ? [] : raw.split("&").filter((p) => p.length > 0);

  let haystack = raw.toLowerCase();
  try {
    haystack += "\n" + decodeURIComponent(raw).toLowerCase();
  } catch {
    // Malformed percent-encoding — match against the raw form only.
  }
  const suspicious = SUSPICIOUS_QUERY_MARKERS.some((marker) => haystack.includes(marker));

  return {
    query_length: raw.length,
    query_param_count: params.length,
    query_suspicious: suspicious,
  };
}

export function buildAnalyticsEvent(
  request: Request,
  decision: Decision,
  context: BuildAnalyticsEventContext
): AnalyticsEvent {
  const headers = request.headers;
  const timestamp = context.timestamp ?? new Date();
  const url = safeUrl(request.url);
  const query = querySignals(url);
  const cdn = context.cdnSignals ?? {};
  const clientIp = normalizeClientIp(context.clientIp);

  return {
    timestamp: isoUtc(timestamp),
    request_id: context.requestId,
    schema_version: SCHEMA_VERSION,
    source_cdn: context.sourceCdn,

    user_agent: headers.get("user-agent") ?? "",
    client_ip: clientIp,
    path: url?.pathname ?? "",
    method: request.method,
    referer: headers.get("referer") ?? "",
    accept_language: headers.get("accept-language") ?? "",

    request_country: context.requestCountry ?? null,
    request_asn: context.requestAsn ?? null,
    tls_fingerprint: context.tlsFingerprint ?? null,

    has_token: decision.hasToken,
    token_outcome: decision.tokenOutcome,
    final_action: decision.finalAction,
    enforcement_mode: enforcementModeToWire(decision.enforcementMode),

    signature_agent: headers.get("signature-agent"),
    signature_input: headers.get("signature-input"),
    signature: headers.get("signature"),

    // --- Capture v2: portable header signals ---
    sec_fetch_mode: headers.get("sec-fetch-mode"),
    sec_fetch_site: headers.get("sec-fetch-site"),
    sec_fetch_dest: headers.get("sec-fetch-dest"),
    sec_fetch_user: headers.get("sec-fetch-user"),
    sec_ch_ua: truncate(headers.get("sec-ch-ua")),
    sec_ch_ua_mobile: headers.get("sec-ch-ua-mobile"),
    sec_ch_ua_platform: headers.get("sec-ch-ua-platform"),
    accept: truncate(headers.get("accept")),
    // The reconstructed URL is the viewer's; the Host header is the hop's wherever a CDN
    // rewrote it before us — Fastly's `override_host` on a VCL → Compute chain, CloudFront at
    // origin-request. Where nothing rewrote it the two agree, so preferring the URL is only
    // ever a correction. The header stays as the fallback for a URL that would not parse.
    host: url?.host ?? headers.get("host") ?? null,
    has_cookies: headers.has("cookie"),
    header_names: collectHeaderNames(headers),

    // Query-string derived signals (raw query never stored).
    query_length: query.query_length,
    query_param_count: query.query_param_count,
    query_suspicious: query.query_suspicious,

    // --- Capture v2: CDN plumbing (passthrough from the handler context) ---
    accept_encoding: cdn.accept_encoding ?? null,
    http_protocol: cdn.http_protocol ?? null,
    tls_version: cdn.tls_version ?? null,
    tls_cipher: cdn.tls_cipher ?? null,
    tls_client_hello_length: cdn.tls_client_hello_length ?? null,
    tls_client_extensions_sha1: cdn.tls_client_extensions_sha1 ?? null,
    as_organization: truncate(cdn.as_organization ?? null),
    client_tcp_rtt: cdn.client_tcp_rtt ?? null,
    cdn_verified_bot_category: cdn.cdn_verified_bot_category ?? null,
    request_priority: cdn.request_priority ?? null,
    tls_fingerprint_ja4: cdn.tls_fingerprint_ja4 ?? null,

    // --- Capture v3 ---
    client_ip_source: reconcileIpSource(clientIp, context.clientIpSource),
    status_code: context.statusCode ?? null,
    status_source: context.statusSource ?? null,
  };
}

function enforcementModeToWire(mode: EnforcementMode): "observe" | "enforce" | "disabled" {
  switch (mode) {
    case EnforcementMode.OBSERVE:
      return "observe";
    case EnforcementMode.ENFORCE:
      return "enforce";
    case EnforcementMode.DISABLED:
      return "disabled";
  }
}
