interface SupertabConnectConfig {
    apiKey: string;
    merchantSystemId: string;
    baseUrl?: string;
    debug?: boolean;
}
interface TokenVerificationResult {
    valid: boolean;
    reason?: string;
    payload?: any;
}

declare class SupertabConnect {
    private apiKey;
    private baseUrl;
    private merchantSystemId;
    constructor(config: SupertabConnectConfig);
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
    cloudflareHandleRequest(request: Request, ctx?: any): Promise<Response>;
    fastlyHandleRequest(request: Request, ctx?: any): Promise<Response>;
}

export { SupertabConnect };
