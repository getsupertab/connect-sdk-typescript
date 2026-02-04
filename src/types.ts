export enum EnforcementMode {
  DISABLED = "disabled",
  SOFT = "soft",
  STRICT = "strict",
}

export type BotDetector = (request: Request, ctx?: any) => boolean;

export interface SupertabConnectConfig {
  apiKey: string;
  merchantSystemUrn: string;
  enforcement?: EnforcementMode;
  botDetector?: BotDetector;
  debug?: boolean;
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
  license_id?: string;
  merchant_system_urn: string;
  properties: Record<string, any>;
}

export type LicenseTokenVerificationResult =
  | { valid: true; licenseId?: string; payload: any }
  | { valid: false; reason: LicenseTokenInvalidReason; licenseId?: string };

export enum LicenseTokenInvalidReason {
  MISSING_TOKEN = "missing_license_token",
  INVALID_HEADER = "invalid_license_header",
  INVALID_ALG = "invalid_license_algorithm",
  INVALID_PAYLOAD = "invalid_license_payload",
  INVALID_ISSUER = "invalid_license_issuer",
  SIGNATURE_VERIFICATION_FAILED = "license_signature_verification_failed",
  EXPIRED = "license_token_expired",
  INVALID_AUDIENCE = "invalid_license_audience",
  SERVER_ERROR = "server_error",
}

export const FASTLY_BACKEND = "stc-backend";

export interface FetchOptions extends RequestInit {
  // Fastly-specific extension for backend routing
  backend?: string;
}

export enum HandlerAction {
  ALLOW = "allow",
  BLOCK = "block",
}

export type HandlerResult =
  | { action: HandlerAction.ALLOW; headers?: Record<string, string> }
  | { action: HandlerAction.BLOCK; status: number; body: string; headers: Record<string, string> };