import {
  SupertabConnectConfig,
  Env,
  EventPayload,
  TokenVerificationResult,
  TokenInvalidReason,
} from "./types";
import {
  jwtVerify,
  decodeProtectedHeader,
  decodeJwt,
  JWTHeaderParameters,
  JWTPayload,
} from "jose";

export type { Env } from './types';

// In-memory cache for JWK sets
const jwksCache = new Map<string, any>();
const debug = false;

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
export class SupertabConnect {
  private apiKey?: string;
  private baseUrl?: string;
  private merchantSystemId?: string;

  private static _instance: SupertabConnect | null = null;

  public constructor(config: SupertabConnectConfig, reset: boolean = false) {
    if (!reset && SupertabConnect._instance) {
      // If reset was not requested and an instance conflicts with the provided config, throw an error
      if (!(
          config.apiKey === SupertabConnect._instance.apiKey &&
          config.merchantSystemId === SupertabConnect._instance.merchantSystemId
      )) {
        throw new Error("Cannot create a new instance with different configuration. Use resetInstance to clear the existing instance.");
      }

      // If an instance already exists and reset is not requested, just return the existing instance
      return SupertabConnect._instance;
    }
    if (reset && SupertabConnect._instance) {
      // ...and if reset is requested and required, clear the existing instance first
      SupertabConnect.resetInstance();
    }

    if (!config.apiKey || !config.merchantSystemId) {
        throw new Error(
            "Missing required configuration: apiKey and merchantSystemId are required"
        );
    }
    this.apiKey = config.apiKey;
    this.merchantSystemId = config.merchantSystemId;
    this.baseUrl = "https://api-connect.sbx.supertab.co";

    // Register this as the singleton instance
    SupertabConnect._instance = this;
  }

  public static resetInstance(): void {
    SupertabConnect._instance = null;
  }

  /**
   * Get the JWKS for a given issuer, using cache if available
   * @private
   */
  private async getJwksForIssuer(issuer: string): Promise<any> {
    if (!jwksCache.has(issuer)) {
      const jwksUrl = `${
        this.baseUrl
      }/.well-known/jwks.json/${encodeURIComponent(issuer)}`;

      try {
        const jwksResponse = await fetch(jwksUrl);
        if (!jwksResponse.ok) {
          throw new Error(`Failed to fetch JWKS: ${jwksResponse.status}`);
        }

        const jwksData = await jwksResponse.json();
        jwksCache.set(issuer, jwksData);
      } catch (error) {
        if (debug) {
          console.error("Error fetching JWKS:", error);
        }
        throw error;
      }
    }

    return jwksCache.get(issuer);
  }

  /**
   * Verify a JWT token
   * @param token The JWT token to verify
   * @returns A promise that resolves with the verification result
   */
  async verifyToken(token: string): Promise<TokenVerificationResult> {
    // 1. Check if token exists
    if (!token) {
      return {
        valid: false,
        reason: TokenInvalidReason.MISSING_TOKEN,
      };
    }

    // 2. Verify header and algorithm
    let header: JWTHeaderParameters;
    try {
      header = decodeProtectedHeader(token) as JWTHeaderParameters;
    } catch (error) {
      if (debug) {
        console.error("Invalid JWT header:", error);
      }
      return {
        valid: false,
        reason: TokenInvalidReason.INVALID_HEADER,
      };
    }

    if (header.alg !== "RS256") {
      return {
        valid: false,
        reason: TokenInvalidReason.INVALID_ALG,
      };
    }

    // 3. Verify payload and issuer
    let payload: JWTPayload;
    try {
      payload = decodeJwt(token);
    } catch (error) {
      if (debug) {
        console.error("Invalid JWT payload:", error);
      }
      return {
        valid: false,
        reason: TokenInvalidReason.INVALID_PAYLOAD,
      };
    }

    const issuer: string | undefined = payload.iss;
    if (!issuer || !issuer.startsWith("urn:stc:customer:")) {
      return {
        valid: false,
        reason: TokenInvalidReason.INVALID_ISSUER,
      };
    }

    // 4. Verify signature
    try {
      const jwks = await this.getJwksForIssuer(issuer);

      // Create a key finder function for verification
      const getKey = async (header: JWTHeaderParameters) => {
        const jwk = jwks.keys.find((key: any) => key.kid === header.kid);
        if (!jwk) throw new Error(`No matching key found: ${header.kid}`);
        return jwk;
      };

      const result = await jwtVerify(token, getKey, {
        issuer,
        algorithms: ["RS256"],
        clockTolerance: "1m",
      });

      // Success case - token is valid
      return {
        valid: true,
        payload: result.payload,
      };
    } catch (error: any) {
      if (debug) {
        console.error("JWT verification failed:", error);
      }

      // Check if token is expired
      if (error.message?.includes("exp")) {
        return {
          valid: false,
          reason: TokenInvalidReason.EXPIRED,
        };
      }

      return {
        valid: false,
        reason: TokenInvalidReason.SIGNATURE_VERIFICATION_FAILED,
      };
    }
  }

  /**
   * Records an analytics event
   * @param eventName Name of the event to record
   * @param customerToken Optional customer token for the event
   * @param properties Additional properties to include with the event
   * @returns Promise that resolves when the event is recorded
   */
  async recordEvent(
    eventName: string,
    customerToken?: string,
    properties: Record<string, any> = {}
  ): Promise<void> {
    const payload: EventPayload = {
      event_name: eventName,
      customer_system_token: customerToken,
      merchant_system_identifier: this.merchantSystemId ? this.merchantSystemId : "",
      properties,
    };

    try {
      const response = await fetch(`${this.baseUrl}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (debug) {
          console.error(`Failed to record event: ${response.status}`);
        }
      }
    } catch (error) {
      if (debug) {
        console.error("Error recording event:", error);
      }
    }
  }

  /**
   * Handle the request, report an event to Supertab Connect and return a response
   */
  private async baseHandleRequest(
      token: string,
      url: string,
      user_agent: string,
      ctx: any
  ): Promise<Response> {

    // 1. Verify token
    const verification = await this.verifyToken(token);

    // Record event helper
    async function recordEvent(stc: SupertabConnect, eventName: string, ctx: any) {
      const eventProperties = {
        page_url: url,
        user_agent: user_agent,
        verification_status: verification.valid ? "valid" : "invalid",
        verification_reason: verification.reason || "success",
      };
      if (ctx) {
        const eventPromise = stc.recordEvent(eventName, token, eventProperties);
        ctx.waitUntil(eventPromise);
        return eventPromise;
      } else {
        return await stc.recordEvent(eventName, token, eventProperties);
      }
    }

    // 2. Handle based on verification result
    if (!verification.valid) {
      await recordEvent(this, verification.reason || "token_verification_failed", ctx);
      const message =
        "❌ Content access denied" +
        (verification.reason ? `: ${verification.reason}` : "");
      return new Response(message, { status: 403, headers: new Headers({ "Content-Type": "application/json" }) });
    }

    // 3. Success
    await recordEvent(this, "page_viewed", ctx);
    return new Response("✅ Content Access granted", {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    });
  }

  private extractDataFromRequest(request: Request): { token: string; url: string; user_agent: string } {
    // Parse token
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    // Extract URL and user agent
    const url = request.url;
    const user_agent = request.headers.get("User-Agent") || "unknown";

    return { token, url, user_agent };
  }

  static async cloudflareHandleRequests(request: Request, env: Env, ctx: any): Promise<Response> {
    // Validate required env variables
    const { MERCHANT_SYSTEM_ID, MERCHANT_API_KEY } = env;

    // Prepare or get the SupertabConnect instance
    const supertabConnect = new SupertabConnect({
      apiKey: MERCHANT_API_KEY,
      merchantSystemId: MERCHANT_SYSTEM_ID,
    });

    // Handle the request, including bot detection, token verification and recording the event
    return supertabConnect.handleRequest(request, undefined, ctx);
  }

  static async fastlyHandleRequests(request: Request, merchantSystemId: string, merchantApiKey: string): Promise<Response> {
    // Prepare or get the SupertabConnect instance
    const supertabConnect = new SupertabConnect({
      apiKey: merchantApiKey,
      merchantSystemId: merchantSystemId,
    });

    // Handle the request, including bot detection, token verification and recording the event
    return supertabConnect.handleRequest(request, undefined, null);
  }

  async handleRequest(request: Request, botDetectionHandler?: (request: Request, ctx?: any) => boolean,  ctx?: any): Promise<Response> {
    // 1. Extract token, URL, and user agent from the request
    const { token, url, user_agent } = this.extractDataFromRequest(request);

    // 2. Handle bot detection if provided
    if (botDetectionHandler && !botDetectionHandler(request, ctx)) {
      return new Response("✅ Non-Bot Content Access granted", {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
      });
    }

    // 3. Call the base handle request method and return the result
    return this.baseHandleRequest(token, url, user_agent, ctx);
  }
}
