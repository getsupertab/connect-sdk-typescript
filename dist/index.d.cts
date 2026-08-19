declare enum EnforcementMode {
    DISABLED = "disabled",
    OBSERVE = "observe",
    ENFORCE = "enforce"
}
interface ExecutionContext {
    waitUntil(promise: Promise<void>): void;
}
type BotDetector = (request: Request, ctx?: ExecutionContext) => boolean;
interface SupertabConnectConfig {
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
}
/**
 * Defines the shape for environment variables (used in CloudFlare integration).
 * These are used to identify and authenticate the Merchant System with the Supertab Connect API.
 */
interface Env {
    /** The API key for authenticating with the Supertab Connect. */
    MERCHANT_API_KEY: string;
    [key: string]: string;
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
    BLOCK = "block",
    RESPOND = "respond"
}
/**
 * Why an analytics event's `status_code` holds what it holds. A bare null is uninterpretable:
 * "the origin failed, so there is no status" is a fact about the request, while "this runtime
 * never sees responses" is a gap in our capture, and a score that averages the two is wrong
 * in a way nothing downstream can detect.
 */
type StatusSource = "observed" | "origin_error" | "unobserved";
/**
 * Present on a HandlerResult only when the caller opted into deferred analytics and the SDK
 * could honour it. Call it once the final response is in hand — from a `finally`, so a thrown
 * origin fetch still reports. Calling it is what sends the event: skip it and no event is sent
 * at all. Calling it twice sends one event, not two.
 */
interface ResponseReporter {
    reportResponse?: (status: number | null, source?: StatusSource) => void;
}
type HandlerResult = ({
    action: HandlerAction.ALLOW;
    headers?: Record<string, string>;
} | {
    action: HandlerAction.BLOCK;
    status: number;
    body: string;
    headers: Record<string, string>;
} | {
    action: HandlerAction.RESPOND;
    status: number;
    body: string;
    headers: Record<string, string>;
}) & ResponseReporter;
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
    botDetector?: BotDetector;
    enforcement?: EnforcementMode;
    /** Enable debug logging (default: false). */
    debug?: boolean;
    /**
     * Toggle relay analytics emission (default: false). Lambda@Edge has no `waitUntil`
     * keep-alive, so the emit is awaited before the response returns rather than
     * fired-and-forgotten (capped by `analyticsTimeoutMs`). At origin-request only
     * licensed/identified-bot traffic pays that cost; at viewer-request every request does.
     */
    analyticsEnabled?: boolean;
    /**
     * Whether to run the full verification/analytics pipeline on every request instead of
     * only those carrying an `x-license-auth` header (or the status probe). Default
     * (undefined): auto-detect — process everything when the event is a viewer-request
     * (which fires pre-cache on all traffic and has no CloudFront Function headers), keep
     * the `x-license-auth` gate at origin-request. Pass true/false to force either mode;
     * note that forcing true at origin-request still only ever sees cache misses.
     */
    processAllRequests?: boolean;
    /**
     * Base URL of the analytics ingest relay, for non-prod deployments (e.g.
     * `https://ingest-connect.sbx.supertab.co`). Defaults to the prod ingest service.
     */
    analyticsBaseUrl?: string;
    /**
     * Optional cap (ms) on the pre-response wait for the analytics emit / event recording.
     * Default: no cap — everything is awaited to completion. When set, whatever is still
     * in flight at expiry is dropped.
     */
    analyticsTimeoutMs?: number;
}
type RSLVerificationResult = {
    valid: boolean;
    error?: string;
};
/**
 * Minimal shape of the Fastly Compute `FetchEvent` that `fastlyHandleRequests` reads.
 * The runtime's real `FetchEvent` is structurally compatible, so callers pass the event
 * directly. Named distinctly to avoid colliding with any DOM/WebWorker `FetchEvent` lib type.
 */
interface FastlyGeolocation {
    country_code: string | null;
    as_number: number | null;
}
interface FastlyClientInfo {
    address: string;
    geo: FastlyGeolocation | null;
    tlsJA3MD5: string | null;
}
interface FastlyFetchEvent {
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
type FastlyHandlerOptions = FastlyHandlerWithRSL | FastlyHandlerWithoutRSL;

declare enum UsageType {
    ALL = "all",
    SEARCH = "search",
    AI_ALL = "ai-all",
    AI_TRAIN = "ai-train",
    AI_INDEX = "ai-index",
    AI_INPUT = "ai-input"
}

type SourceCdn = "cloudflare" | "fastly" | "cloudfront";
/**
 * Where `client_ip` came from. Provenance, never a verdict on the address — whether
 * it is the visitor or a middleman is decided in the warehouse, against `request_asn`.
 *
 * - `cdn_declared` — the CDN's view of who connected *to it*. The strongest claim any
 *   CDN can make, and still only one hop out: if something sits in front of the CDN,
 *   this is that something.
 * - `connection` — the socket peer this runtime observed. The real client on a direct
 *   deployment, an upstream hop on a chained one; the runtime cannot tell which.
 * - `absent` — no address available, so `client_ip` is the `::` sentinel.
 *
 * Undeclared (omitted) is a fourth state and stays NULL: an integrator passing its own
 * `clientIp` knows its provenance and we do not, so we never guess on its behalf.
 */
type ClientIpSource = "cdn_declared" | "connection" | "absent";
type TokenOutcome = "absent" | "valid" | "expired" | "invalid_signature" | "invalid_audience" | "invalid_resource" | "invalid_issuer" | "malformed" | "server_error" | "not_validated";
type FinalAction = "allow" | "observe" | "block";
interface AnalyticsEvent {
    timestamp: string;
    request_id: string;
    schema_version: number;
    source_cdn: SourceCdn | null;
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
    enforcement_mode: "observe" | "enforce" | "disabled";
    signature_agent: string | null;
    signature_input: string | null;
    signature: string | null;
    sec_fetch_mode: string | null;
    sec_fetch_site: string | null;
    sec_fetch_dest: string | null;
    sec_fetch_user: string | null;
    sec_ch_ua: string | null;
    sec_ch_ua_mobile: string | null;
    sec_ch_ua_platform: string | null;
    accept: string | null;
    host: string | null;
    has_cookies: boolean | null;
    header_names: string[];
    query_length: number | null;
    query_param_count: number | null;
    query_suspicious: boolean | null;
    accept_encoding: string | null;
    http_protocol: string | null;
    tls_version: string | null;
    tls_cipher: string | null;
    tls_client_hello_length: number | null;
    tls_client_extensions_sha1: string | null;
    as_organization: string | null;
    client_tcp_rtt: number | null;
    cdn_verified_bot_category: string | null;
    request_priority: string | null;
    tls_fingerprint_ja4: string | null;
    client_ip_source: ClientIpSource | null;
    status_code: number | null;
    status_source: StatusSource | null;
}
/**
 * CDN-supplied request signals that cannot be read from the portable `Request`
 * — extracted per platform (Cloudflare `request.cf`, Fastly headers) and
 * threaded through the handler context. Keys match the wire (snake_case) field
 * names so they pass straight through onto the event.
 */
interface CdnRequestSignals {
    accept_encoding?: string | null;
    http_protocol?: string | null;
    tls_version?: string | null;
    tls_cipher?: string | null;
    tls_client_hello_length?: number | null;
    tls_client_extensions_sha1?: string | null;
    as_organization?: string | null;
    client_tcp_rtt?: number | null;
    cdn_verified_bot_category?: string | null;
    request_priority?: string | null;
    tls_fingerprint_ja4?: string | null;
}
interface AnalyticsTransport {
    emit(event: AnalyticsEvent, ctx?: ExecutionContext): void;
}

interface HandleRequestContext {
    ctx?: ExecutionContext;
    sourceCdn?: "cloudflare" | "fastly" | "cloudfront";
    clientIp?: string;
    clientIpSource?: ClientIpSource;
    deferAnalytics?: boolean;
    requestId?: string;
    requestCountry?: string | null;
    requestAsn?: number | null;
    tlsFingerprint?: string | null;
    cdnSignals?: CdnRequestSignals;
}

/**
 * Default bot detection logic using multiple signals.
 * Checks User-Agent patterns, headless browser indicators, missing headers, and Cloudflare bot scores.
 * @param request The incoming request to analyze
 * @returns true if the request appears to be from a bot, false otherwise
 */
declare function defaultBotDetector(request: Request): boolean;

/**
 * Fastly-only transport selection, owned by the Fastly handler (not the platform-agnostic
 * SupertabConnect constructor). Returns a FastlyLogTransport when the merchant opted into
 * native bot-events logging (`logEndpoint` set) and identity can be stamped (`merchantSystemUrn`);
 * otherwise `undefined`, leaving the constructor to pick the HTTP relay / no-op.
 */
declare function selectFastlyAnalyticsTransport(opts: {
    analyticsEnabled?: boolean;
    logEndpoint?: string;
    merchantSystemUrn?: string;
    debug?: boolean;
}): AnalyticsTransport | undefined;

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
declare class SupertabConnect {
    private apiKey?;
    private static baseUrl;
    private static analyticsBaseUrl;
    private enforcement;
    private botDetector?;
    private debug;
    private analyticsTransport;
    private analyticsEnabled;
    private static _instance;
    /**
     * Create a new SupertabConnect instance (singleton).
     * If an instance with the same apiKey already exists, it is reconfigured with the
     * provided options (last write wins) and returned — important on warm serverless
     * containers, where the module (and singleton) outlives a single invocation.
     * @param config SDK configuration including apiKey
     * @param reset Pass true to replace an existing instance with different config
     * @throws If an instance with a different apiKey already exists and reset is false
     */
    constructor(config: SupertabConnectConfig, reset?: boolean);
    private applyConfig;
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
     * Override the base URL of the analytics ingest relay (e.g. for a non-prod environment
     * or local development). Independent of setBaseUrl — token/JWKS/verify traffic is
     * unaffected. Can also be set per-instance via the `analyticsBaseUrl` config option.
     */
    static setAnalyticsBaseUrl(url: string): void;
    /**
     * Get the current base URL of the analytics ingest relay.
     */
    static getAnalyticsBaseUrl(): string;
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
     * @returns A promise that resolves with the handler result indicating ALLOW or BLOCK
     */
    handleRequest(request: Request, context?: HandleRequestContext): Promise<HandlerResult>;
    /**
     * The enforcement decision itself. Split out so the public entry point has one exit at
     * which to attach the response reporter — every emit() call below stays where it was.
     */
    private decide;
    /**
     * Request a license token from the Supertab Connect token endpoint.
     * If usage type is specified and matching serverless content permits it, skips token request and returns undefined.
     *
     * The request always carries client credentials + the resource URL, and takes one of two lanes:
     * - RSL License path: the merchant's live public license.xml still has a `<content>` block
     *   matching the resource. The `<license>` chunk is sent to that block's own URN-scoped
     *   `{server}/token` endpoint, keeping the flow RSL-standards compliant.
     * - Agreement path: no block matches. The chunk is omitted and the request goes license-less to
     *   the generic `{baseUrl}/token` endpoint, where the backend resolves the merchant system from
     *   the resource URL and the customer's single Active Agreement and mints against that
     *   Agreement's pinned license snapshot. Entitlement is decided server-side, so a diverged
     *   license.xml that no longer grants the resource never vetoes the request client-side.
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
        usage?: UsageType;
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
     * @param options.analyticsEnabled Toggle relay analytics emission (default: false)
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
        originUrl?: string;
    }): Promise<Response>;
    /**
     * Handle incoming requests for Fastly Compute.
     * @param event The Fastly `FetchEvent`. Viewer IP/geo/JA3 are resolved internally: on a
     *   VCL→Compute chain from the `Fastly-Client-IP` header + `fastly:geolocation` (JA3 dropped),
     *   otherwise from `event.client`. See `resolveFastlyClientSignals`.
     * @param merchantApiKey The merchant API key for authentication
     * @param originBackend The Fastly backend name to forward allowed requests to
     * @param options Optional configuration items
     * @param options.enableRSL Serve license.xml at /license.xml for RSL-compliant clients (default: false)
     * @param options.botDetector Custom bot detection function
     * @param options.enforcement Enforcement mode (default: OBSERVE)
     * @param options.analyticsEnabled Toggle relay analytics emission (default: false)
     */
    static fastlyHandleRequests(event: FastlyFetchEvent, merchantApiKey: string, originBackend: string, options?: FastlyHandlerOptions): Promise<Response>;
    /**
     * Handle incoming requests for AWS CloudFront Lambda@Edge.
     * Works at either trigger: attached at viewer-request it runs pre-cache on every request
     * (full analytics coverage, no CloudFront Function needed); attached at origin-request it
     * only processes requests the CloudFront Function stamped with `x-license-auth` (plus the
     * status probe). The trigger is auto-detected from the event — see
     * CloudfrontHandlerOptions.processAllRequests to force either mode.
     * @param event The CloudFront request event (viewer-request or origin-request)
     * @param options Configuration including apiKey and optional botDetector/enforcement/debug fields.
     * @param options.analyticsEnabled Toggle relay analytics emission (default: false). Lambda@Edge
     *   has no `waitUntil`, so the emit is awaited to completion before the response returns —
     *   see CloudfrontHandlerOptions.
     * @param options.analyticsTimeoutMs Optional cap (ms) on that wait; events still in flight
     *   when it expires are dropped. Default: no cap, fully awaited.
     */
    static cloudfrontHandleRequests<TRequest extends Record<string, any>>(event: CloudFrontRequestEvent<TRequest>, options: CloudfrontHandlerOptions): Promise<CloudFrontRequestResult<TRequest>>;
}

export { type AnalyticsEvent, type AnalyticsTransport, type BotDetector, CDNStatusDescription, type CloudFrontRequestEvent, type CloudFrontRequestResult, type CloudfrontHandlerOptions, EnforcementMode, type Env, type ExecutionContext, type FastlyFetchEvent, type FastlyHandlerOptions, HandlerAction, type HandlerResult, LicenseTokenInvalidReason, type RSLVerificationResult, SupertabConnect, type SupertabConnectConfig, UsageType, defaultBotDetector, selectFastlyAnalyticsTransport };
