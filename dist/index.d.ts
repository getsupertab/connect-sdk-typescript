declare enum EnforcementMode {
    DISABLED = "disabled",
    SOFT = "soft",
    STRICT = "strict"
}
type BotDetector = (request: Request, ctx?: any) => boolean;
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
type LicenseTokenVerificationResult = {
    valid: true;
    licenseId?: string;
    payload: any;
} | {
    valid: false;
    reason: LicenseTokenInvalidReason;
    licenseId?: string;
};
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
     * Verify a license token
     * @param licenseToken The license token to verify
     * @param requestUrl The URL of the request being made
     * @returns A promise that resolves with the verification result
     */
    verifyLicenseToken(licenseToken: string, requestUrl: string): Promise<LicenseTokenVerificationResult>;
    /**
     * Records an analytics event
     * @param eventName Name of the event to record
     * @param properties Additional properties to include with the event
     * @param licenseId Optional license ID associated with the event
     * @returns Promise that resolves when the event is recorded
     */
    recordEvent(eventName: string, properties?: Record<string, any>, licenseId?: string): Promise<void>;
    handleRequest(request: Request, ctx?: any): Promise<HandlerResult>;
    /**
     * Request a license token from the Supertab Connect token endpoint.
     * Automatically fetches and parses license.xml from the resource URL's origin,
     * using the token endpoint specified in the matching content element's server attribute.
     * @param clientId OAuth client identifier.
     * @param clientSecret OAuth client secret for client_credentials flow.
     * @param resourceUrl Resource URL attempting to access with a License.
     * @param debug Enable debug logging (default: false).
     * @returns Promise resolving to the issued license access token string.
     */
    static obtainLicenseToken(clientId: string, clientSecret: string, resourceUrl: string, debug?: boolean): Promise<string>;
    /**
     * Handle incoming requests for Cloudflare Workers.
     */
    static cloudflareHandleRequests(request: Request, env: Env, ctx: any): Promise<Response>;
    /**
     * Handle incoming requests for Fastly Compute.
     */
    static fastlyHandleRequests(request: Request, merchantSystemUrn: string, merchantApiKey: string, originBackend: string, options?: {
        enableRSL?: boolean;
        botDetector?: BotDetector;
        enforcement?: EnforcementMode;
    }): Promise<Response>;
}

export { type BotDetector, EnforcementMode, type Env, HandlerAction, type HandlerResult, SupertabConnect, defaultBotDetector };
