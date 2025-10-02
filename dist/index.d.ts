interface SupertabConnectConfig {
    apiKey: string;
    merchantSystemUrn: string;
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
    private static baseUrl;
    private merchantSystemUrn?;
    private static _instance;
    constructor(config: SupertabConnectConfig, reset?: boolean);
    static resetInstance(): void;
    /**
     * Override the default base URL for API requests (intended for local development/testing).
     */
    static setBaseUrl(url: string): void;
    /**
     * Verify a JWT token
     * @param token The JWT token to verify
     * @returns A promise that resolves with the verification result
     */
    verifyToken(token: string): Promise<TokenVerificationResult>;
    /**
     * Records an analytics event
     * @param eventName Name of the event to record
     * @param properties Additional properties to include with the event
     * @param licenseId Optional license ID associated with the event
     * @returns Promise that resolves when the event is recorded
     */
    recordEvent(eventName: string, properties?: Record<string, any>, licenseId?: string): Promise<void>;
    /**
     * Handle the request, report an event to Supertab Connect and return a response
     */
    private baseHandleRequest;
    /**
     * Handle the request for license tokens, report an event to Supertab Connect and return a response
     */
    private baseLicenseHandleRequest;
    private extractDataFromRequest;
    static checkIfBotRequest(request: Request): boolean;
    static cloudflareHandleRequests(request: Request, env: Env, ctx: any): Promise<Response>;
    static fastlyHandleRequests(request: Request, merchantSystemUrn: string, merchantApiKey: string): Promise<Response>;
    handleRequest(request: Request, botDetectionHandler?: (request: Request, ctx?: any) => boolean, ctx?: any): Promise<Response>;
    /**
     * Request a license token from the Supertab Connect token endpoint.
     * @param clientId OAuth client identifier used for the assertion issuer/subject claims.
     * @param kid The key ID to include in the JWT header.
     * @param privateKeyPem Private key in PEM format used to sign the client assertion.
     * @param tokenEndpoint Token endpoint URL.
     * @param resourceUrl Resource URL attempting to access with a License.
     * @param licenseXml XML license document to include in the request payload.
     * @returns Promise resolving to the issued license access token string.
     */
    static generateLicenseToken(clientId: string, kid: string, privateKeyPem: string, tokenEndpoint: string, resourceUrl: string, licenseXml: string): Promise<string>;
    /** Generate a customer JWT
     * @param customerURN The customer's unique resource name (URN).
     * @param kid The key ID to include in the JWT header.
     * @param privateKeyPem The private key in PEM format used to sign the JWT.
     * @param expirationSeconds The token's expiration time in seconds (default is 3600 seconds).
     * @returns A promise that resolves to the generated JWT as a string.
     */
    static generateCustomerJWT(customerURN: string, kid: string, privateKeyPem: string, expirationSeconds?: number): Promise<string>;
}

export { type Env, SupertabConnect };
