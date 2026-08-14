import { EnforcementMode, ExecutionContext, LicenseTokenInvalidReason } from "../types";

export const SCHEMA_VERSION = 3;

export type SourceCdn = "cloudflare" | "fastly" | "cloudfront";

/**
 * Where `client_ip` came from. Provenance, never a verdict on the address — whether
 * it is the visitor or a middleman is decided in the warehouse, against `request_asn`.
 *
 * - `cdn_declared` — the CDN's view of who connected *to it*. The strongest claim any
 *   CDN can make, and still only one hop out: if something sits in front of the CDN,
 *   this is that something.
 * - `connection` — the socket peer this runtime observed. The real client on a direct
 *   deployment, an upstream hop on a chained one; the runtime cannot tell which.
 * - `absent` — no address available, so `client_ip` is the `::` sentinel.
 *
 * Undeclared (omitted) is a fourth state and stays NULL: an integrator passing its own
 * `clientIp` knows its provenance and we do not, so we never guess on its behalf.
 */
export type ClientIpSource = "cdn_declared" | "connection" | "absent";

export type TokenOutcome =
  | "absent"
  | "valid"
  | "expired"
  | "invalid_signature"
  | "invalid_audience"
  | "invalid_resource"
  | "invalid_issuer"
  | "malformed"
  | "server_error"
  | "not_validated";

export type FinalAction = "allow" | "observe" | "block";

export interface Decision {
  hasToken: boolean;
  tokenOutcome: TokenOutcome;
  finalAction: FinalAction;
  enforcementMode: EnforcementMode;
}

export interface AnalyticsEvent {
  timestamp: string;
  request_id: string;
  schema_version: number;
  // null when the request did not pass through a CDN (e.g. invoked directly via the SDK).
  source_cdn: SourceCdn | null;

  user_agent: string;
  client_ip: string;
  path: string;
  method: string;
  referer: string;
  accept_language: string;

  // Classification signals — supplied by the CDN layer (platform-specific). null when not exposed.
  request_country: string | null;
  request_asn: number | null;
  tls_fingerprint: string | null;

  has_token: boolean;
  token_outcome: TokenOutcome;
  final_action: FinalAction;
  enforcement_mode: "observe" | "enforce" | "disabled";

  // HTTP Message Signature headers — platform-agnostic, read directly from request headers.
  signature_agent: string | null;
  signature_input: string | null;
  signature: string | null;

  // --- Capture v2 (schema_version 2): spoof-detection signals ---
  // Portable header signals — read directly from request headers (every CDN).
  sec_fetch_mode: string | null;
  sec_fetch_site: string | null;
  sec_fetch_dest: string | null;
  sec_fetch_user: string | null;
  sec_ch_ua: string | null;
  sec_ch_ua_mobile: string | null;
  sec_ch_ua_platform: string | null;
  accept: string | null;
  host: string | null;
  has_cookies: boolean | null;
  // Lowercased, deduped, sorted request-header names with edge-injected headers
  // (cf-*, x-forwarded-*, x-real-ip) stripped. Non-nullable: [] when none.
  header_names: string[];

  // Query-string derived signals. The raw query is NEVER stored (PII gate →
  // option b); only these mechanical derivations are emitted.
  query_length: number | null;
  query_param_count: number | null;
  query_suspicious: boolean | null;

  // CDN plumbing — not derivable from the portable Request. Cloudflare reads
  // these from request.cf; Fastly maps what its headers expose; null elsewhere.
  accept_encoding: string | null;
  http_protocol: string | null;
  tls_version: string | null;
  tls_cipher: string | null;
  tls_client_hello_length: number | null;
  tls_client_extensions_sha1: string | null;
  as_organization: string | null;
  client_tcp_rtt: number | null;
  cdn_verified_bot_category: string | null;
  request_priority: string | null;
  tls_fingerprint_ja4: string | null;

  // --- Capture v3 (schema_version 3) ---
  client_ip_source: ClientIpSource | null;
}

/**
 * CDN-supplied request signals that cannot be read from the portable `Request`
 * — extracted per platform (Cloudflare `request.cf`, Fastly headers) and
 * threaded through the handler context. Keys match the wire (snake_case) field
 * names so they pass straight through onto the event.
 */
export interface CdnRequestSignals {
  accept_encoding?: string | null;
  http_protocol?: string | null;
  tls_version?: string | null;
  tls_cipher?: string | null;
  tls_client_hello_length?: number | null;
  tls_client_extensions_sha1?: string | null;
  as_organization?: string | null;
  client_tcp_rtt?: number | null;
  cdn_verified_bot_category?: string | null;
  request_priority?: string | null;
  tls_fingerprint_ja4?: string | null;
}

export interface AnalyticsTransport {
  emit(event: AnalyticsEvent, ctx?: ExecutionContext): void;
}

export const TOKEN_OUTCOME_BY_REASON: Record<LicenseTokenInvalidReason, TokenOutcome> = {
  [LicenseTokenInvalidReason.MISSING_TOKEN]: "absent",
  [LicenseTokenInvalidReason.EXPIRED]: "expired",
  [LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED]: "invalid_signature",
  [LicenseTokenInvalidReason.INVALID_AUDIENCE]: "invalid_audience",
  [LicenseTokenInvalidReason.INVALID_ISSUER]: "invalid_issuer",
  [LicenseTokenInvalidReason.INVALID_HEADER]: "malformed",
  [LicenseTokenInvalidReason.INVALID_PAYLOAD]: "malformed",
  [LicenseTokenInvalidReason.INVALID_ALG]: "malformed",
  [LicenseTokenInvalidReason.SERVER_ERROR]: "server_error",
};
