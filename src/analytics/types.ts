import { EnforcementMode, ExecutionContext, LicenseTokenInvalidReason } from "../types";

export const SCHEMA_VERSION = 1;

export type SourceCdn = "cloudflare" | "fastly" | "cloudfront";

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
  source_cdn: SourceCdn;

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
