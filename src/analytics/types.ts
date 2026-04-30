import { EnforcementMode, ExecutionContext, LicenseTokenInvalidReason } from "../types";

export const SCHEMA_VERSION = 1;

export type SourceCdn = "cloudflare" | "fastly" | "cloudfront";

export type BotVerdict =
  | "unknown"
  | "human"
  | "verified_bot"
  | "unverified_bot"
  | "suspicious";

export type TokenOutcome =
  | "absent"
  | "valid"
  | "expired"
  | "invalid_signature"
  | "invalid_audience"
  | "invalid_resource"
  | "invalid_issuer"
  | "malformed"
  | "server_error";

export type FinalAction = "allow" | "observe" | "block";

export interface Decision {
  hasToken: boolean;
  tokenOutcome: TokenOutcome;
  botVerdict: BotVerdict;
  finalAction: FinalAction;
  enforcementMode: EnforcementMode;
}

export interface AnalyticsEvent {
  merchant_id: string;
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

  has_token: boolean;
  token_outcome: TokenOutcome;
  bot_detector_result: BotVerdict;
  final_action: FinalAction;
  enforcement_mode: "observe" | "enforce" | "disabled";
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
