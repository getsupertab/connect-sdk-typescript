import { EnforcementMode } from "../types";
import { normalizeClientIp } from "./ip";
import { AnalyticsEvent, CdnRequestSignals, Decision, SCHEMA_VERSION, SourceCdn } from "./types";

export interface BuildAnalyticsEventContext {
  requestId: string;
  sourceCdn: SourceCdn | null;
  clientIp?: string | null;
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
// the shared `x-forwarded-*` / `x-real-ip`, and the SDK's own routing header
// `x-original-request-url` (set by the Fastly/CloudFront handlers).
const EDGE_HEADER_PREFIXES = ["cf-", "fastly-", "cloudfront-", "x-forwarded-"];
const EDGE_HEADER_NAMES = new Set(["x-real-ip", "x-original-request-url"]);

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

  return {
    timestamp: isoUtc(timestamp),
    request_id: context.requestId,
    schema_version: SCHEMA_VERSION,
    source_cdn: context.sourceCdn,

    user_agent: headers.get("user-agent") ?? "",
    client_ip: normalizeClientIp(context.clientIp),
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
    // Host is a forbidden header in some runtimes; fall back to the parsed URL.
    host: headers.get("host") ?? url?.host ?? null,
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
