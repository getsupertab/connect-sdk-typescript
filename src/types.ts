export interface SupertabConnectConfig {
  apiKey: string;
  merchantSystemUrn: string;
}

/**
 * Defines the shape for environment variables (used in CloudFlare integration).
 * These are used to identify and authenticate the Merchant System with the Supertab Connect API.
 */
export interface Env {
	/** The unique identifier for the merchant system. */
	MERCHANT_SYSTEM_URN: string;
	/** The API key for authenticating with the Supertab Connect. */
	MERCHANT_API_KEY: string;
	[key: string]: string;
}

export interface EventPayload {
  event_name: string;
  customer_system_token?: string;
  merchant_system_urn: string;
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
