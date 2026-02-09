declare enum EnforcementMode {
    DISABLED = "disabled",
    SOFT = "soft",
    STRICT = "strict"
}
interface ExecutionContext {
    waitUntil(promise: Promise<any>): void;
}
type BotDetector = (request: Request, ctx?: ExecutionContext) => boolean;
interface SupertabConnectConfig {
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
interface Env {
    /** The unique identifier for the merchant system. */
    MERCHANT_SYSTEM_URN: string;
    /** The API key for authenticating with the Supertab Connect. */
    MERCHANT_API_KEY: string;
    [key: string]: string;
}
declare enum HandlerAction {
    ALLOW = "allow",
    BLOCK = "block"
}
type HandlerResult = {
    action: HandlerAction.ALLOW;
    headers?: Record<string, string>;
} | {
    action: HandlerAction.BLOCK;
    status: number;
    body: string;
    headers: Record<string, string>;
};
interface CloudFrontHeaders {
    [key: string]: Array<{
        key?: string;
        value: string;
    }>;
}
interface CloudFrontResultResponse {
    status: string;
    statusDescription?: string;
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
}
type RSLVerificationResult = {
    valid: boolean;
    error?: string;
};

/**
 * Default bot detection logic using multiple signals.
 * Checks User-Agent patterns, headless browser indicators, missing headers, and Cloudflare bot scores.
 * @param request The incoming request to analyze
 * @returns true if the request appears to be from a bot, false otherwise
 */
declare function defaultBotDetector(request: Request): boolean;

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
declare class SupertabConnect {
    private apiKey?;
    private static baseUrl;
    private merchantSystemUrn;
    private enforcement;
    private botDetector?;
    private debug;
    private static _instance;
    constructor(config: SupertabConnectConfig, reset?: boolean);
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
     * Uses the instance's apiKey and merchantSystemUrn for event recording.
     * @param options.token The license token to verify
     * @param options.resourceUrl The URL of the resource being accessed
     * @param options.userAgent Optional user agent string for event recording
     * @param options.debug Enable debug logging (default: false)
     * @param options.ctx Optional execution context with waitUntil for non-blocking event recording
     * @returns A promise that resolves with the verification result
     */
    verifyAndRecord(options: {
        token: string;
        resourceUrl: string;
        userAgent?: string;
        debug?: boolean;
        ctx?: ExecutionContext;
    }): Promise<RSLVerificationResult>;
    /**
     * Handle an incoming request by extracting the license token, verifying it, and recording an analytics event.
     * When no token is present, bot detection and enforcement mode determine the response.
     * @param request The incoming HTTP request
     * @param ctx Execution context for non-blocking event recording.
     *   Pass this from your platform (e.g. Cloudflare Workers)
     * @returns A promise that resolves with the handler result indicating ALLOW or  BLOCK request
     */
    handleRequest(request: Request, ctx?: ExecutionContext): Promise<HandlerResult>;
    /**
     * Request a license token from the Supertab Connect token endpoint.
     * @param options.clientId OAuth client identifier.
     * @param options.clientSecret OAuth client secret for client_credentials flow.
     * @param options.resourceUrl Resource URL attempting to access with a License.
     * @param options.debug Enable debug logging (default: false).
     * @returns Promise resolving to the issued license access token string.
     */
    static obtainLicenseToken(options: {
        clientId: string;
        clientSecret: string;
        resourceUrl: string;
        debug?: boolean;
    }): Promise<string>;
    /**
     * Handle incoming requests for Cloudflare Workers.
     */
    static cloudflareHandleRequests(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
    /**
     * Handle incoming requests for Fastly Compute.
     */
    static fastlyHandleRequests(request: Request, merchantSystemUrn: string, merchantApiKey: string, originBackend: string, options?: {
        enableRSL?: boolean;
        botDetector?: BotDetector;
        enforcement?: EnforcementMode;
    }): Promise<Response>;
    /**
     * Handle incoming requests for AWS CloudFront Lambda@Edge.
     */
    static cloudfrontHandleRequests<TRequest extends Record<string, any>>(event: CloudFrontRequestEvent<TRequest>, options: CloudfrontHandlerOptions): Promise<CloudFrontRequestResult<TRequest>>;
}

export { type BotDetector, type CloudFrontRequestEvent, type CloudFrontRequestResult, type CloudfrontHandlerOptions, EnforcementMode, type Env, type ExecutionContext, HandlerAction, type HandlerResult, type RSLVerificationResult, SupertabConnect, defaultBotDetector };
