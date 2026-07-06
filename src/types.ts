import type { JWTPayload } from "jose";
import type { AnalyticsTransport } from "./analytics/types";

export enum EnforcementMode {
  DISABLED = "disabled",
  OBSERVE = "observe",
  ENFORCE = "enforce",
}

export interface ExecutionContext {
  waitUntil(promise: Promise<void>): void;
}

export type BotDetector = (request: Request, ctx?: ExecutionContext) => boolean;

export interface SupertabConnectConfig {
  apiKey: string;
  enforcement?: EnforcementMode;
  botDetector?: BotDetector;
  debug?: boolean;
  /** Enables analytics emission to the Supertab Connect relay. Default: false. */
  analyticsEnabled?: boolean;
  /**
   * @internal
   * Internal dependency-injection seam: overrides the default HttpAnalyticsTransport when provided.
   * Used by tests (to inject in-memory transports) and by internal transport selection. NOT a
   * merchant-facing option — the public CDN handlers do not expose it; merchants configure analytics
   * declaratively via `analyticsEnabled`.
   */
  analyticsTransport?: AnalyticsTransport;
}

/**
 * Defines the shape for environment variables (used in CloudFlare integration).
 * These are used to identify and authenticate the Merchant System with the Supertab Connect API.
 */
export interface Env {
	/** The API key for authenticating with the Supertab Connect. */
	MERCHANT_API_KEY: string;
	[key: string]: string;
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
  BLOCK = "block",
  RESPOND = "respond",
}

export type HandlerResult =
  | { action: HandlerAction.ALLOW; headers?: Record<string, string> }
  | { action: HandlerAction.BLOCK; status: number; body: string; headers: Record<string, string> }
  | { action: HandlerAction.RESPOND; status: number; body: string; headers: Record<string, string> };

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
  botDetector?: BotDetector;
  enforcement?: EnforcementMode;
}

export type RSLVerificationResult = {
  valid: boolean;
  error?: string;
};

/**
 * Minimal shape of the Fastly Compute `FetchEvent` that `fastlyHandleRequests` reads.
 * The runtime's real `FetchEvent` is structurally compatible, so callers pass the event
 * directly. Named distinctly to avoid colliding with any DOM/WebWorker `FetchEvent` lib type.
 */
export interface FastlyGeolocation {
  country_code: string | null;
  as_number: number | null;
}

export interface FastlyClientInfo {
  address: string;
  geo: FastlyGeolocation | null;
  tlsJA3MD5: string | null;
}

export interface FastlyFetchEvent {
  request: Request;
  client: FastlyClientInfo;
}

interface FastlyHandlerBaseOptions {
  botDetector?: BotDetector;
  enforcement?: EnforcementMode;
  analyticsEnabled?: boolean;
  /**
   * Merchant system URN, stamped onto Fastly analytics rows (the relay derives it server-side;
   * the Fastly → S3 path must carry it). Required when `enableRSL`, and for native Fastly logging
   * (with `logEndpoint`); without it analytics falls back to the HTTP relay.
   */
  merchantSystemUrn?: string;
  /**
   * Named Fastly logging endpoint to emit bot events to — must match the endpoint configured on
   * the Fastly service. Set it to enable native Fastly logging; without it, analytics falls back
   * to the HTTP relay.
   */
  logEndpoint?: string;
}

interface FastlyHandlerWithRSL extends FastlyHandlerBaseOptions {
  enableRSL: true;
  /** Required for RSL license.xml hosting (also used to stamp analytics rows when enabled). */
  merchantSystemUrn: string;
}

interface FastlyHandlerWithoutRSL extends FastlyHandlerBaseOptions {
  enableRSL?: false;
}

export type FastlyHandlerOptions = FastlyHandlerWithRSL | FastlyHandlerWithoutRSL;
