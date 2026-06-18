import { EnforcementMode, LicenseTokenInvalidReason } from "./types";

/**
 * Controlled vocabularies for the Tinybird `bot_events_raw` datasource. These MUST
 * stay in sync with the warehouse contract (see backend `handlers/schemas/ingest`
 * and `tinybird/lib/datasources.py`).
 */
export type TokenOutcome =
  | "absent"
  | "valid"
  | "expired"
  | "invalid_signature"
  | "invalid_audience"
  | "invalid_resource"
  | "malformed"
  | "invalid_issuer"
  | "server_error"
  | "not_validated";

export type FinalAction = "allow" | "block" | "observe";

export type EnforcementOutcome = "observe" | "enforce" | "disabled";

/** Ingest schema version emitted in every row. Bump when the row shape changes. */
export const BOT_EVENTS_SCHEMA_VERSION = 1;

/** A single `bot_events_raw` row — one request-layer ingest event. */
export interface BotEventRow {
  merchant_system_urn: string;
  /** ISO-8601 UTC with milliseconds (e.g. `2026-06-18T10:30:00.123Z`); maps to DateTime64(3,'UTC'). */
  timestamp: string;
  request_id: string;
  schema_version: number;
  source_cdn: string;
  user_agent: string;
  client_ip: string;
  path: string;
  method: string;
  referer: string;
  accept_language: string;
  request_country: string | null;
  request_asn: number | null;
  tls_fingerprint: string | null;
  has_token: boolean;
  token_outcome: TokenOutcome;
  final_action: FinalAction;
  enforcement_mode: EnforcementOutcome;
  signature_agent: string | null;
  signature_input: string | null;
  signature: string | null;
}

/** Map the SDK enforcement mode to the warehouse `enforcement_mode` vocabulary. */
export function toEnforcementOutcome(mode: EnforcementMode): EnforcementOutcome {
  switch (mode) {
    case EnforcementMode.STRICT:
      return "enforce";
    case EnforcementMode.SOFT:
      return "observe";
    case EnforcementMode.DISABLED:
      return "disabled";
  }
}

/** Map a license-token failure reason to the warehouse `token_outcome` vocabulary. */
export function toTokenOutcome(reason: LicenseTokenInvalidReason): TokenOutcome {
  switch (reason) {
    case LicenseTokenInvalidReason.MISSING_TOKEN:
      return "absent";
    case LicenseTokenInvalidReason.EXPIRED:
      return "expired";
    case LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED:
      return "invalid_signature";
    case LicenseTokenInvalidReason.INVALID_AUDIENCE:
      return "invalid_audience";
    case LicenseTokenInvalidReason.INVALID_ISSUER:
      return "invalid_issuer";
    case LicenseTokenInvalidReason.INVALID_HEADER:
    case LicenseTokenInvalidReason.INVALID_ALG:
    case LicenseTokenInvalidReason.INVALID_PAYLOAD:
      return "malformed";
    case LicenseTokenInvalidReason.SERVER_ERROR:
      return "server_error";
  }
}

/**
 * The request-classification signals the handler determines, already mapped to the
 * warehouse vocabularies. These come from `handleRequest` (wiring is a separate
 * subtask, STC-697 emit / handler enrichment); the builder only consumes them.
 */
export interface BotEventSignals {
  has_token: boolean;
  token_outcome: TokenOutcome;
  final_action: FinalAction;
  enforcement_mode: EnforcementOutcome;
}

export interface BuildBotEventRowInput {
  merchantSystemUrn: string;
  /** The viewer request — `user_agent`, `referer`, `accept_language`, `path`, `method` come from here. */
  request: Request;
  clientIp: string;
  signals: BotEventSignals;
  /** Event time. Passed in (not read from a clock) so the builder stays pure/testable. */
  timestamp: Date;
  /** Unique per request. Passed in (not generated here) so the builder stays pure/testable. */
  requestId: string;
  requestCountry?: string | null;
  requestAsn?: number | null;
  tlsFingerprint?: string | null;
  /** Defaults to `"fastly"`. */
  sourceCdn?: string;
  signatureAgent?: string | null;
  signatureInput?: string | null;
  signature?: string | null;
}

/**
 * Build a `bot_events_raw` row from a request plus the classification signals.
 *
 * Pure: no clock, no randomness, no network — `timestamp`/`requestId` are inputs.
 * The caller (the Fastly path) supplies `clientIp`, geo, and `signals`; how those are
 * obtained (handler enrichment, Fastly client/geo) is decided in the wiring subtasks.
 */
export function buildBotEventRow(input: BuildBotEventRowInput): BotEventRow {
  const { request } = input;
  const header = (name: string): string => request.headers.get(name) ?? "";
  return {
    merchant_system_urn: input.merchantSystemUrn,
    timestamp: input.timestamp.toISOString(),
    request_id: input.requestId,
    schema_version: BOT_EVENTS_SCHEMA_VERSION,
    source_cdn: input.sourceCdn ?? "fastly",
    user_agent: header("user-agent"),
    client_ip: input.clientIp,
    path: new URL(request.url).pathname,
    method: request.method,
    referer: header("referer"),
    accept_language: header("accept-language"),
    request_country: input.requestCountry ?? null,
    request_asn: input.requestAsn ?? null,
    tls_fingerprint: input.tlsFingerprint ?? null,
    has_token: input.signals.has_token,
    token_outcome: input.signals.token_outcome,
    final_action: input.signals.final_action,
    enforcement_mode: input.signals.enforcement_mode,
    signature_agent: input.signatureAgent ?? null,
    signature_input: input.signatureInput ?? null,
    signature: input.signature ?? null,
  };
}
