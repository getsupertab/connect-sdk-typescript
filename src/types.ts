import type { JWTPayload } from "jose";
import type { AnalyticsTransport, BotVerdict } from "./analytics/types";

export enum EnforcementMode {
  DISABLED = "disabled",
  OBSERVE = "observe",
  ENFORCE = "enforce",
}

export interface ExecutionContext {
  waitUntil(promise: Promise<void>): void;
}

export type BotDetector = (request: Request, ctx?: ExecutionContext) => BotVerdict;

export interface SupertabConnectConfig {
  apiKey: string;
  /**
   * Stable merchant identifier stamped on analytics events. Distinct from `apiKey`,
   * which is a rotatable credential. Required so analytics rows survive key rotation.
   */
  merchantId: string;
  enforcement?: EnforcementMode;
  botDetector?: BotDetector;
  debug?: boolean;
  /** Enables analytics emission. Default: false. */
  analyticsEnabled?: boolean;
  /** Tinybird Events API token. When absent and analyticsEnabled is true, a warning is logged once and emission no-ops. */
  analyticsToken?: string;
  /** Override the default Tinybird endpoint (region-specific). */
  analyticsEndpoint?: string;
  /** DI hook for tests/custom transports. Overrides the default HttpAnalyticsTransport when provided. */
  analyticsTransport?: AnalyticsTransport;
}

/**
 * Defines the shape for environment variables (used in CloudFlare integration).
 * These are used to identify and authenticate the Merchant System with the Supertab Connect API.
 */
export interface Env {
	/** The API key for authenticating with the Supertab Connect. */
	MERCHANT_API_KEY: string;
	/** Stable merchant identifier stamped on analytics events. */
	MERCHANT_ID: string;
	/** Optional Tinybird Events API token for analytics emission. */
	SUPERTAB_ANALYTICS_TOKEN?: string;
	[key: string]: string | undefined;
}

export interface EventPayload {
  event_name: string;
  license_id?: string;
  properties: Record<string, string>;
}

export type LicenseTokenVerificationResult =
  | { valid: true; licenseId?: string; payload: JWTPayload }
  | { valid: false; reason: LicenseTokenInvalidReason; error: string; licenseId?: string };

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

declare global {
  // eslint-disable-next-line no-var
  var fastly: object | undefined;
}

export const FASTLY_BACKEND = "stc-backend";

export interface FetchOptions extends RequestInit {
  // Fastly-specific extension for backend routing
  backend?: string;
}

export enum HandlerAction {
  ALLOW = "allow",
  OBSERVE = "observe",
  BLOCK = "block",
}

export type HandlerResult =
  | { action: HandlerAction.ALLOW; headers?: Record<string, string> }
  | { action: HandlerAction.OBSERVE; headers: Record<string, string> }
  | { action: HandlerAction.BLOCK; status: number; body: string; headers: Record<string, string> };

export enum CDNStatusDescription {
  Unauthorized = "Unauthorized",
  PaymentRequired = "Payment Required",
  Forbidden = "Forbidden",
  ServiceUnavailable = "Service Unavailable",
  Error = "Error",
}

// CloudFront Lambda@Edge types
// Uses permissive types to be compatible with aws-lambda package types
export interface CloudFrontHeaders {
  [key: string]: Array<{ key?: string; value: string }>;
}

export interface CloudFrontResultResponse {
  status: string;
  statusDescription?: CDNStatusDescription;
  headers?: CloudFrontHeaders;
  bodyEncoding?: "text" | "base64";
  body?: string;
}

// CloudFrontRequestEvent uses a generic request type to accept aws-lambda's CloudFrontRequest
export interface CloudFrontRequestEvent<TRequest = Record<string, any>> {
  Records: Array<{
    cf: {
      config?: {
        distributionDomainName?: string;
        distributionId?: string;
        eventType?: string;
        requestId?: string;
      };
      request: TRequest & {
        uri: string;
        method: string;
        querystring: string;
        headers: CloudFrontHeaders;
        clientIp?: string;
      };
    };
  }>;
}

// Result can be either the original request (pass-through) or a response
// Using generic to preserve the original request type for pass-through
export type CloudFrontRequestResult<TRequest = Record<string, any>> = TRequest | CloudFrontResultResponse;

export interface CloudfrontHandlerOptions {
  apiKey: string;
  merchantId: string;
  botDetector?: BotDetector;
  enforcement?: EnforcementMode;
  analyticsEnabled?: boolean;
  analyticsToken?: string;
  analyticsEndpoint?: string;
}

export type RSLVerificationResult = {
  valid: boolean;
  error?: string;
};

interface FastlyHandlerBaseOptions {
  merchantId: string;
  botDetector?: BotDetector;
  enforcement?: EnforcementMode;
  analyticsEnabled?: boolean;
  analyticsToken?: string;
  analyticsEndpoint?: string;
}

interface FastlyHandlerWithRSL extends FastlyHandlerBaseOptions {
  enableRSL: true;
  merchantSystemUrn: string;
}

interface FastlyHandlerWithoutRSL extends FastlyHandlerBaseOptions {
  enableRSL?: false;
  merchantSystemUrn?: never;
}

export type FastlyHandlerOptions = FastlyHandlerWithRSL | FastlyHandlerWithoutRSL;
