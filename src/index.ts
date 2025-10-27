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
import {
  generateLicenseToken as generateLicenseTokenHelper,
  generateCustomerJWT as generateCustomerJWTHelper,
} from "./customer";
import {
  baseLicenseHandleRequest as baseLicenseHandleRequestHelper,
  hostRSLicenseXML as hostRSLicenseXMLHelper,
} from "./license";
import { fetchIssuerJwks, fetchPlatformJwks } from "./jwks";

export type { Env } from "./types";

const debug = true; // Set to true for debugging purposes

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
export class SupertabConnect {
  private apiKey?: string;
  private static baseUrl: string = "https://api-connect.sbx.supertab.co";
  private merchantSystemUrn!: string;

  private static _instance: SupertabConnect | null = null;

  public constructor(config: SupertabConnectConfig, reset: boolean = false) {
    if (!reset && SupertabConnect._instance) {
      // If reset was not requested and an instance conflicts with the provided config, throw an error
      if (
        !(
          config.apiKey === SupertabConnect._instance.apiKey &&
          config.merchantSystemUrn ===
            SupertabConnect._instance.merchantSystemUrn
        )
      ) {
        throw new Error(
          "Cannot create a new instance with different configuration. Use resetInstance to clear the existing instance."
        );
      }

      // If an instance already exists and reset is not requested, just return the existing instance
      return SupertabConnect._instance;
    }
    if (reset && SupertabConnect._instance) {
      // ...and if reset is requested and required, clear the existing instance first
      SupertabConnect.resetInstance();
    }

    if (!config.apiKey || !config.merchantSystemUrn) {
      throw new Error(
        "Missing required configuration: apiKey and merchantSystemUrn are required"
      );
    }
    this.apiKey = config.apiKey;
    this.merchantSystemUrn = config.merchantSystemUrn;

    // Register this as the singleton instance
    SupertabConnect._instance = this;
  }

  public static resetInstance(): void {
    SupertabConnect._instance = null;
  }

  /**
   * Override the default base URL for API requests (intended for local development/testing).
   */
  public static setBaseUrl(url: string): void {
    SupertabConnect.baseUrl = url;
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
      const jwks = await fetchIssuerJwks(
        SupertabConnect.baseUrl,
        issuer,
        debug
      );

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
   * @param properties Additional properties to include with the event
   * @param licenseId Optional license ID associated with the event
   * @returns Promise that resolves when the event is recorded
   */
  async recordEvent(
    eventName: string,
    properties: Record<string, any> = {},
    licenseId?: string
  ): Promise<void> {
    const payload: EventPayload = {
      event_name: eventName,
      merchant_system_urn: this.merchantSystemUrn ? this.merchantSystemUrn : "",
      license_id: licenseId,
      properties,
    };

    try {
      let options: any = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      };
      // @ts-ignore
      if (globalThis?.fastly) {
        options = { ...options, backend: "sbx-backend" };
      }
      const response = await fetch(
        `${SupertabConnect.baseUrl}/events`,
        options
      );

      if (!response.ok) {
        console.log(`Failed to record event: ${response.status}`);
      }
    } catch (error) {
      console.log("Error recording event:", error);
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
    async function recordEvent(
      stc: SupertabConnect,
      eventName: string,
      ctx: any
    ) {
      const eventProperties = {
        page_url: url,
        user_agent: user_agent,
        verification_status: verification.valid ? "valid" : "invalid",
        verification_reason: verification.reason || "success",
      };
      if (ctx) {
        const eventPromise = stc.recordEvent(eventName, eventProperties);
        ctx.waitUntil(eventPromise);
        return eventPromise;
      } else {
        return await stc.recordEvent(eventName, eventProperties);
      }
    }

    // 2. Handle based on verification result
    if (!verification.valid) {
      await recordEvent(
        this,
        verification.reason || "token_verification_failed",
        ctx
      );
      const message =
        "Payment required: you need to present a valid Supertab Connect token to access this content. " +
        "Check out the provided url for details";
      const details =
        "❌ Content access denied" +
        (verification.reason ? `: ${verification.reason}` : "");
      const contentAccessUrl = `${SupertabConnect.baseUrl}/merchants/systems/${this.merchantSystemUrn}/content-access.json`;

      const responseBody = {
        url: contentAccessUrl,
        message: message,
        details: details,
      };

      return new Response(JSON.stringify(responseBody), {
        status: 402,
        headers: new Headers({ "Content-Type": "application/json" }),
      });
    }

    // 3. Success
    await recordEvent(this, "page_viewed", ctx);
    return new Response("✅ Content Access granted", {
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
    });
  }

  /**
   * Handle the request for license tokens, report an event to Supertab Connect and return a response
   */
  private async baseLicenseHandleRequest(
    licenseToken: string,
    url: string,
    user_agent: string,
    ctx: any
  ): Promise<Response> {
    return baseLicenseHandleRequestHelper({
      licenseToken,
      url,
      userAgent: user_agent,
      ctx,
      supertabBaseUrl: SupertabConnect.baseUrl,
      merchantSystemUrn: this.merchantSystemUrn,
      debug,
      recordEvent: (
        eventName: string,
        properties?: Record<string, any>,
        licenseId?: string
      ) => this.recordEvent(eventName, properties, licenseId),
    });
  }

  private extractDataFromRequest(request: Request): {
    token: string;
    licenseToken: string;
    url: string;
    user_agent: string;
  } {
    // Parse token
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const licenseToken = auth.startsWith("License ") ? auth.slice(8) : "";

    // Extract URL and user agent
    const url = request.url;
    const user_agent = request.headers.get("User-Agent") || "unknown";

    return { token, licenseToken, url, user_agent };
  }

  static checkIfBotRequest(request: Request): boolean {
    const userAgent = request.headers.get("User-Agent") || "";
    const accept = request.headers.get("accept") || "";
    const secChUa = request.headers.get("sec-ch-ua");
    const acceptLanguage = request.headers.get("accept-language");
    const botScore = (request as any).cf?.botManagement?.score;

    const botList = [
      "chatgpt-user",
      "perplexitybot",
      "gptbot",
      "anthropic-ai",
      "ccbot",
      "claude-web",
      "claudebot",
      "cohere-ai",
      "youbot",
      "diffbot",
      "oai-searchbot",
      "meta-externalagent",
      "timpibot",
      "amazonbot",
      "bytespider",
      "perplexity-user",
      "googlebot",
      "bot",
      "curl",
      "wget",
    ];
    // 1. Basic substring check from known list
    const lowerCaseUserAgent = userAgent.toLowerCase();
    const botUaMatch = botList.some((bot) => lowerCaseUserAgent.includes(bot));

    // 2. Headless browser detection
    const headlessIndicators =
      userAgent.toLowerCase().includes("headless") ||
      userAgent.toLowerCase().includes("puppeteer") ||
      !secChUa;

    const only_sec_ch_ua_missing =
      !userAgent.toLowerCase().includes("headless") ||
      !userAgent.toLowerCase().includes("puppeteer") ||
      !secChUa;

    // 3. Suspicious header gaps — many bots omit these
    const missingHeaders = !accept || !acceptLanguage;

    // 4. Cloudflare bot score check (if available)
    const lowBotScore = typeof botScore === "number" && botScore < 30;
    console.log("Bot Detection Details:", {
      botUaMatch,
      headlessIndicators,
      missingHeaders,
      lowBotScore,
      botScore,
    });

    // Safari and Mozilla special case
    if (
      lowerCaseUserAgent.includes("safari") ||
      lowerCaseUserAgent.includes("mozilla")
    ) {
      // Safari is not a bot, but it may be headless
      if (headlessIndicators && only_sec_ch_ua_missing) {
        return false; // Likely not a bot, but missing a Sec-CH-UA header
      }
    }

    // Final decision
    return botUaMatch || headlessIndicators || missingHeaders || lowBotScore;
  }

  static async cloudflareHandleRequests(
    request: Request,
    env: Env,
    ctx: any
  ): Promise<Response> {
    // Validate required env variables
    const { MERCHANT_SYSTEM_URN, MERCHANT_API_KEY } = env;

    // Prepare or get the SupertabConnect instance
    const supertabConnect = new SupertabConnect({
      apiKey: MERCHANT_API_KEY,
      merchantSystemUrn: MERCHANT_SYSTEM_URN,
    });

    // Handle the request, including bot detection, token verification and recording the event
    return supertabConnect.handleRequest(
      request,
      SupertabConnect.checkIfBotRequest,
      ctx
    );
  }

  static async fastlyHandleRequests(
    request: Request,
    merchantSystemUrn: string,
    merchantApiKey: string,
    enableRSL: boolean = false,
  ): Promise<Response> {
    // Prepare or get the SupertabConnect instance
    const supertabConnect = new SupertabConnect({
      apiKey: merchantApiKey,
      merchantSystemUrn: merchantSystemUrn,
    });

    if (enableRSL) {
      if (new URL(request.url).pathname === "/license.xml") {
        return await hostRSLicenseXMLHelper(
          SupertabConnect.baseUrl,
          merchantSystemUrn
        );
      }
    }

    // Handle the request, including bot detection, token verification and recording the event
    return supertabConnect.handleRequest(
      request,
      SupertabConnect.checkIfBotRequest,
      null
    );
  }

  async handleRequest(
    request: Request,
    botDetectionHandler?: (request: Request, ctx?: any) => boolean,
    ctx?: any
  ): Promise<Response> {
    // 1. Extract token, license token, URL, and user agent from the request
    const { token, licenseToken, url, user_agent } =
      this.extractDataFromRequest(request);

    // 2. Handle bot detection if provided
    if (botDetectionHandler && !botDetectionHandler(request, ctx)) {
      return new Response("✅ Non-Bot Content Access granted", {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
      });
    }

    // 3. Check for bearer token first, then fallback to license token
    if (token) {
      return this.baseHandleRequest(token, url, user_agent, ctx);
    }

    // 4. Call the base licenhandle request method and return the result
    return this.baseLicenseHandleRequest(licenseToken, url, user_agent, ctx);
  }

  async hostRSLicenseXML(): Promise<Response> {
    return hostRSLicenseXMLHelper(
      SupertabConnect.baseUrl,
      this.merchantSystemUrn
    );
  }

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
  static async generateLicenseToken(
    clientId: string,
    kid: string,
    privateKeyPem: string,
    tokenEndpoint: string,
    resourceUrl: string,
    licenseXml: string
  ): Promise<string> {
    return generateLicenseTokenHelper({
      clientId,
      kid,
      privateKeyPem,
      tokenEndpoint,
      resourceUrl,
      licenseXml,
      debug,
    });
  }


  /** Generate a customer JWT
   * @param customerURN The customer's unique resource name (URN).
   * @param kid The key ID to include in the JWT header.
   * @param privateKeyPem The private key in PEM format used to sign the JWT.
   * @param expirationSeconds The token's expiration time in seconds (default is 3600 seconds).
   * @returns A promise that resolves to the generated JWT as a string.
   */
  static async generateCustomerJWT(
    customerURN: string,
    kid: string,
    privateKeyPem: string,
    expirationSeconds: number = 3600
  ): Promise<string> {
    return generateCustomerJWTHelper({
      customerURN,
      kid,
      privateKeyPem,
      expirationSeconds,
    });
  }
}
