type SourceCdn = "cloudflare" | "fastly" | "cloudfront";
type BotVerdict = "unknown" | "human" | "verified_bot" | "unverified_bot" | "suspicious";
type TokenOutcome = "absent" | "valid" | "expired" | "invalid_signature" | "invalid_audience" | "invalid_resource" | "invalid_issuer" | "malformed" | "server_error";
type FinalAction = "allow" | "observe" | "block";
interface AnalyticsEvent {
    merchant_system_urn: string;
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
interface AnalyticsTransport {
    emit(event: AnalyticsEvent, ctx?: ExecutionContext): void;
}

declare enum EnforcementMode {
    DISABLED = "disabled",
    OBSERVE = "observe",
    ENFORCE = "enforce"
}
interface ExecutionContext {
    waitUntil(promise: Promise<void>): void;
}
type BotDetector = (request: Request, ctx?: ExecutionContext) => BotVerdict;
interface SupertabConnectConfig {
    apiKey: string;
    /**
     * Merchant system URN (e.g. `urn:stc:merchant:system:<uuid>`) stamped on
     * analytics events. Distinct from `apiKey`, which is a rotatable credential —
     * the URN survives key rotation, so historical rows stay attributable.
     */
    merchantSystemUrn: string;
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
interface Env {
    /** The API key for authenticating with the Supertab Connect. */
    MERCHANT_API_KEY: string;
    /** Merchant system URN stamped on analytics events (e.g. `urn:stc:merchant:system:<uuid>`). */
    MERCHANT_SYSTEM_URN: string;
    /** Optional Tinybird Events API token for analytics emission. */
    SUPERTAB_ANALYTICS_TOKEN?: string;
    [key: string]: string | undefined;
}
declare enum LicenseTokenInvalidReason {
    MISSING_TOKEN = "missing_license_token",
    INVALID_HEADER = "invalid_license_header",
    INVALID_ALG = "invalid_license_algorithm",
    INVALID_PAYLOAD = "invalid_license_payload",
    INVALID_ISSUER = "invalid_license_issuer",
    SIGNATURE_VERIFICATION_FAILED = "license_signature_verification_failed",
    EXPIRED = "license_token_expired",
    INVALID_AUDIENCE = "invalid_license_audience",
    SERVER_ERROR = "server_error"
}
declare global {
    var fastly: object | undefined;
}
declare enum HandlerAction {
    ALLOW = "allow",
    OBSERVE = "observe",
    BLOCK = "block"
}
type HandlerResult = {
    action: HandlerAction.ALLOW;
    headers?: Record<string, string>;
} | {
    action: HandlerAction.OBSERVE;
    headers: Record<string, string>;
} | {
    action: HandlerAction.BLOCK;
    status: number;
    body: string;
    headers: Record<string, string>;
};
declare enum CDNStatusDescription {
    Unauthorized = "Unauthorized",
    PaymentRequired = "Payment Required",
    Forbidden = "Forbidden",
    ServiceUnavailable = "Service Unavailable",
    Error = "Error"
}
interface CloudFrontHeaders {
    [key: string]: Array<{
        key?: string;
        value: string;
    }>;
}
interface CloudFrontResultResponse {
    status: string;
    statusDescription?: CDNStatusDescription;
    headers?: CloudFrontHeaders;
    bodyEncoding?: "text" | "base64";
    body?: string;
}
interface CloudFrontRequestEvent<TRequest = Record<string, any>> {
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
type CloudFrontRequestResult<TRequest = Record<string, any>> = TRequest | CloudFrontResultResponse;
interface CloudfrontHandlerOptions {
    apiKey: string;
    merchantSystemUrn: string;
    botDetector?: BotDetector;
    enforcement?: EnforcementMode;
    analyticsEnabled?: boolean;
    analyticsToken?: string;
    analyticsEndpoint?: string;
}
type RSLVerificationResult = {
    valid: boolean;
    error?: string;
};
interface FastlyHandlerOptions {
    merchantSystemUrn: string;
    botDetector?: BotDetector;
    enforcement?: EnforcementMode;
    analyticsEnabled?: boolean;
    analyticsToken?: string;
    analyticsEndpoint?: string;
    enableRSL?: boolean;
}

declare enum UsageType {
    ALL = "all",
    SEARCH = "search",
    AI_ALL = "ai-all",
    AI_TRAIN = "ai-train",
    AI_INDEX = "ai-index",
    AI_INPUT = "ai-input"
}

interface HandleRequestContext {
    ctx?: ExecutionContext;
    sourceCdn: "cloudflare" | "fastly" | "cloudfront";
    clientIp?: string;
    requestId?: string;
}

/**
 * Heuristic bot classification using UA, headers, and Cloudflare bot score.
 *
 * Returns one of:
 *   - 'human'           — request looks like an interactive browser
 *   - 'unverified_bot'  — UA matches a known bot string (not cryptographically verified)
 *   - 'suspicious'      — headless indicators or suspicious header gaps
 *   - 'unknown'         — request has no UA / cannot be classified
 *
 * NOTE: 'verified_bot' is reserved for server-side verification (CAP, HTTP
 * Message Signatures) and is unreachable from this client-side detector.
 */
declare function defaultBotDetector(request: Request): BotVerdict;

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
declare class SupertabConnect {
    private apiKey?;
    private merchantSystemUrn;
    private static baseUrl;
    private enforcement;
    private botDetector?;
    private debug;
    private analyticsTransport;
    private static _instance;
    /**
     * Create a new SupertabConnect instance (singleton).
     * Returns the existing instance if one exists with the same config.
     * @param config SDK configuration including apiKey and merchantSystemUrn
     * @param reset Pass true to replace an existing instance with different config
     * @throws If an instance with different config already exists and reset is false
     */
    constructor(config: SupertabConnectConfig, reset?: boolean);
    private static buildAnalyticsTransport;
    /**
     * Clear the singleton instance, allowing a new one to be created with different config.
     */
    static resetInstance(): void;
    /**
     * Override the default base URL for API requests (intended for local development/testing).
     */
    static setBaseUrl(url: string): void;
    /**
     * Get the current base URL for API requests.
     */
    static getBaseUrl(): string;
    /**
     * Pure token verification — verifies a license token without recording any events.
     * @param options.token The license token to verify
     * @param options.resourceUrl The URL of the resource being accessed
     * @param options.baseUrl Optional override for the Supertab Connect API base URL
     * @param options.debug Enable debug logging (default: false)
     * @returns A promise that resolves with the verification result
     */
    static verify(options: {
        token: string;
        resourceUrl: string;
        baseUrl?: string;
        debug?: boolean;
    }): Promise<RSLVerificationResult>;
    /**
     * Verify a license token and record an analytics event.
     * Uses the instance's apiKey for event recording.
     * @param options.token The license token to verify
     * @param options.resourceUrl The URL of the resource being accessed
     * @param options.userAgent Optional user agent string for event recording
     * @param options.requestHeaders Optional request headers to include in the event properties
     * @param options.debug Enable debug logging (default: false)
     * @param options.ctx Optional execution context with waitUntil for non-blocking event recording
     * @returns A promise that resolves with the verification result
     */
    verifyAndRecord(options: {
        token: string;
        resourceUrl: string;
        userAgent?: string;
        requestHeaders?: Record<string, string>;
        debug?: boolean;
        ctx?: ExecutionContext;
    }): Promise<RSLVerificationResult>;
    /**
     * Handle an incoming request by extracting the license token, verifying it, and recording an analytics event.
     * When no token is present, bot detection and enforcement mode determine the response.
     * @param request The incoming HTTP request
     * @param context CDN-supplied request context (sourceCdn, clientIp, ctx, requestId)
     * @returns A promise that resolves with the handler result indicating ALLOW, OBSERVE, or BLOCK
     */
    handleRequest(request: Request, context?: HandleRequestContext): Promise<HandlerResult>;
    /**
     * Request a license token from the Supertab Connect token endpoint.
     * If usage type is specified and matching serverless content permits it, skips token request and returns undefined.
     * @param options.clientId OAuth client identifier.
     * @param options.clientSecret OAuth client secret for client_credentials flow.
     * @param options.resourceUrl Resource URL attempting to access with a License.
     * @param options.usage Optional usage type.
     *   If specified and a matching serverless content exists in license, no token is issued
     * @param options.debug Enable debug logging (default: false).
     * @returns Promise resolving to the issued license access token string, or `undefined` when no token is needed.
     */
    static obtainLicenseToken(options: {
        clientId: string;
        clientSecret: string;
        resourceUrl: string;
        usage?: undefined;
        debug?: boolean;
    }): Promise<string>;
    static obtainLicenseToken(options: {
        clientId: string;
        clientSecret: string;
        resourceUrl: string;
        usage: UsageType;
        debug?: boolean;
    }): Promise<string | undefined>;
    /**
     * Handle incoming requests for Cloudflare Workers.
     * Pass this directly as your Worker's fetch handler.
     * @param request The incoming Worker request
     * @param env Worker environment bindings containing MERCHANT_API_KEY
     * @param ctx Worker execution context for non-blocking event recording
     * @param options Optional configuration items
     * @param options.botDetector Custom bot detection function
     * @param options.enforcement Enforcement mode (default: OBSERVE)
     * @param options.analyticsEnabled Toggle Tinybird analytics emission (default: false)
     * @param options.analyticsEndpoint Override Tinybird endpoint
     * @param options.originUrl Override the upstream origin for ALLOW/OBSERVE pass-through.
     *   When set, the Worker's `fetch` for forwarded traffic targets `${originUrl}${path}${query}`
     *   instead of `request.url`. License audience / resource verification still uses `request.url`,
     *   so the Worker URL clients hit and the origin URL the Worker forwards to can differ.
     *   Production Cloudflare deployments using Workers Routes can omit this — `fetch(request)`
     *   already resolves to the origin via Cloudflare's edge.
     */
    static cloudflareHandleRequests(request: Request, env: Env, ctx: ExecutionContext, options?: {
        botDetector?: BotDetector;
        enforcement?: EnforcementMode;
        analyticsEnabled?: boolean;
        analyticsEndpoint?: string;
        originUrl?: string;
    }): Promise<Response>;
    /**
     * Handle incoming requests for Fastly Compute.
     * @param request The incoming Fastly request
     * @param merchantApiKey The merchant API key for authentication
     * @param originBackend The Fastly backend name to forward allowed requests to
     * @param options Configuration items
     * @param options.merchantSystemUrn Merchant system URN stamped on analytics events; also used to fetch license.xml when enableRSL is true
     * @param options.enableRSL Serve license.xml at /license.xml for RSL-compliant clients (default: false)
     * @param options.botDetector Custom bot detection function
     * @param options.enforcement Enforcement mode (default: OBSERVE)
     * @param options.analyticsEnabled Toggle Tinybird analytics emission (default: false)
     * @param options.analyticsToken Tinybird Events API token
     * @param options.analyticsEndpoint Override Tinybird endpoint
     */
    static fastlyHandleRequests(request: Request, merchantApiKey: string, originBackend: string, options: FastlyHandlerOptions): Promise<Response>;
    /**
     * Handle incoming requests for AWS CloudFront Lambda@Edge.
     * Use as the handler for an origin-request LambdaEdge function.
     * @param event The CloudFront origin-request event
     * @param options Configuration including apiKey and optional botDetector/enforcement/analytics fields
     */
    static cloudfrontHandleRequests<TRequest extends Record<string, any>>(event: CloudFrontRequestEvent<TRequest>, options: CloudfrontHandlerOptions): Promise<CloudFrontRequestResult<TRequest>>;
}

export { type AnalyticsEvent, type AnalyticsTransport, type BotDetector, type BotVerdict, CDNStatusDescription, type CloudFrontRequestEvent, type CloudFrontRequestResult, type CloudfrontHandlerOptions, EnforcementMode, type Env, type ExecutionContext, type FastlyHandlerOptions, HandlerAction, type HandlerResult, LicenseTokenInvalidReason, type RSLVerificationResult, SupertabConnect, type SupertabConnectConfig, UsageType, defaultBotDetector };
