interface SupertabConnectConfig {
    apiKey: string;
    merchantSystemId: string;
}
/**
 * Defines the shape for environment variables (used in CloudFlare integration).
 * These are used to identify and authenticate the Merchant System with the Supertab Connect API.
 */
interface Env {
    /** The unique identifier for the merchant system. */
    MERCHANT_SYSTEM_ID: string;
    /** The API key for authenticating with the Supertab Connect. */
    MERCHANT_API_KEY: string;
    [key: string]: string;
}
interface TokenVerificationResult {
    valid: boolean;
    reason?: string;
    payload?: any;
}

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
declare class SupertabConnect {
    private apiKey?;
    private baseUrl?;
    private merchantSystemId?;
    readonly id: number;
    private static _instance;
    constructor(config: SupertabConnectConfig, reset?: boolean);
    static resetInstance(): void;
    /**
     * Get the JWKS for a given issuer, using cache if available
     * @private
     */
    private getJwksForIssuer;
    /**
     * Verify a JWT token
     * @param token The JWT token to verify
     * @returns A promise that resolves with the verification result
     */
    verifyToken(token: string): Promise<TokenVerificationResult>;
    /**
     * Records an analytics event
     * @param eventName Name of the event to record
     * @param customerToken Optional customer token for the event
     * @param properties Additional properties to include with the event
     * @returns Promise that resolves when the event is recorded
     */
    recordEvent(eventName: string, customerToken?: string, properties?: Record<string, any>): Promise<void>;
    /**
     * Handle the request, report an event to Supertab Connect and return a response
     */
    private baseHandleRequest;
    private extractDataFromRequest;
    static cloudflareHandleRequests(request: Request, env: Env, ctx: any): Promise<Response>;
    static fastlyHandleRequests(request: Request, merchantSystemId: string, merchantApiKey: string): Promise<Response>;
    handleRequest(request: Request, botDetectionHandler?: (request: Request, ctx?: any) => boolean, ctx?: any): Promise<Response>;
}

export { type Env, SupertabConnect };
