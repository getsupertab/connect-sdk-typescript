import { EnforcementMode } from "../types";
import { normalizeClientIp } from "./ip";
import { AnalyticsEvent, Decision, SCHEMA_VERSION, SourceCdn } from "./types";

export interface BuildAnalyticsEventContext {
  requestId: string;
  sourceCdn: SourceCdn | null;
  clientIp?: string | null;
  timestamp?: Date;
  requestCountry?: string | null;
  requestAsn?: number | null;
  tlsFingerprint?: string | null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function isoUtc(date: Date): string {
  return date.toISOString();
}

export function buildAnalyticsEvent(
  request: Request,
  decision: Decision,
  context: BuildAnalyticsEventContext
): AnalyticsEvent {
  const headers = request.headers;
  const timestamp = context.timestamp ?? new Date();

  return {
    timestamp: isoUtc(timestamp),
    request_id: context.requestId,
    schema_version: SCHEMA_VERSION,
    source_cdn: context.sourceCdn,

    user_agent: headers.get("user-agent") ?? "",
    client_ip: normalizeClientIp(context.clientIp),
    path: safePathname(request.url),
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
