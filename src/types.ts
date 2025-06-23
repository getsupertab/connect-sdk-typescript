export interface SupertabConnectConfig {
  apiKey: string;
  merchantSystemId: string;
  baseUrl?: string;
  debug?: boolean;
}

export interface EventPayload {
  event_name: string;
  customer_system_token?: string;
  merchant_system_identifier: string;
  properties: Record<string, any>;
}

export interface TokenVerificationResult {
  valid: boolean;
  reason?: string;
  payload?: any;
}

export enum TokenInvalidReason {
  MISSING_TOKEN = "missing_token",
  INVALID_HEADER = "invalid_header",
  INVALID_ALG = "invalid_algorithm",
  INVALID_PAYLOAD = "invalid_payload",
  INVALID_ISSUER = "invalid_issuer",
  SIGNATURE_VERIFICATION_FAILED = "signature_verification_failed",
  EXPIRED = "token_expired",
}
