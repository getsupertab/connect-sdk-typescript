import type { JWTPayload } from "jose";
import type { AnalyticsTransport } from "./analytics/types";

export enum EnforcementMode {
  DISABLED = "disabled",
  OBSERVE = "observe",
  ENFORCE = "enforce",
}

export interface ExecutionContext {
  waitUntil(promise: Promise<void>): void;
  /**
   * Cancellation signal for background work (analytics emit, legacy event recording).
   * Set by runtimes that must bound that work with a hard deadline (CloudFront
   * Lambda@Edge); absent on platforms whose native context keeps work alive
   * (Cloudflare, Fastly).
   */
  signal?: AbortSignal;
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
   * Base URL of the analytics ingest relay. Defaults to the dedicated ingest service
   * (`https://ingest-connect.supertab.co`) — separate from the API base URL used for
   * token acquisition / JWKS / verification. Override for non-prod or local development.
   */
  analyticsBaseUrl?: string;
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

/**
 * Why an analytics event's `status_code` holds what it holds. A bare null is uninterpretable:
 * "the origin failed, so there is no status" is a fact about the request, while "this runtime
 * never sees responses" is a gap in our capture, and a score that averages the two is wrong
 * in a way nothing downstream can detect.
 */
export type StatusSource = "observed" | "origin_error" | "unobserved";

/**
 * Present on a HandlerResult only when the caller opted into deferred analytics and the SDK
 * could honour it. Call it once the final response is in hand — from a `finally`, so a thrown
 * origin fetch still reports. Calling it is what sends the event: skip it and no event is sent
 * at all. Calling it twice sends one event, not two.
 */
export interface ResponseReporter {
  reportResponse?: (status: number | null, source?: StatusSource) => void;
}

export type HandlerResult = (
  | { action: HandlerAction.ALLOW; headers?: Record<string, string> }
  | { action: HandlerAction.BLOCK; status: number; body: string; headers: Record<string, string> }
  | { action: HandlerAction.RESPOND; status: number; body: string; headers: Record<string, string> }
) &
  ResponseReporter;

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
  /** Enable debug logging (default: false). */
  debug?: boolean;
  /**
   * Toggle relay analytics emission (default: false). Lambda@Edge has no `waitUntil`
   * keep-alive, so the emit is awaited before the response returns rather than
   * fired-and-forgotten (bounded by `backgroundWorkTimeoutMs`). At origin-request only
   * licensed/identified-bot traffic pays that cost; at viewer-request every request does.
   */
  analyticsEnabled?: boolean;
  /**
   * Base URL of the analytics ingest relay, for non-prod deployments (e.g.
   * `https://ingest-connect.sbx.supertab.co`). Defaults to the prod ingest service.
   */
  analyticsBaseUrl?: string;
  /**
   * Absolute budget (ms), measured from handler entry, on the pre-response wait for
   * background work (the analytics emit and legacy event recording). At the deadline the
   * in-flight calls are ABORTED — not merely abandoned — so nothing keeps running into a
   * frozen/reused Lambda environment. Default: no budget — everything is awaited to
   * completion. Non-finite or non-positive values are ignored with a warning.
   */
  backgroundWorkTimeoutMs?: number;
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
  /**
   * Keeps the Compute instance alive until `promise` settles. Threaded through as the
   * analytics `ExecutionContext` so fire-and-forget emits (esp. on the BLOCK path, which
   * returns immediately with no origin round-trip) aren't cut off at teardown.
   */
  waitUntil(promise: Promise<any>): void;
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
