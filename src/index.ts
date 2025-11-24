import {
  SupertabConnectConfig,
  Env,
  EventPayload,
  FASTLY_BACKEND,
} from "./types";
import { generateLicenseToken as generateLicenseTokenHelper } from "./customer";
import {
  baseLicenseHandleRequest as baseLicenseHandleRequestHelper,
  hostRSLicenseXML as hostRSLicenseXMLHelper,
} from "./license";

export type { Env } from "./types";

const debug = true; // Set to true for debugging purposes

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
export class SupertabConnect {
  private apiKey?: string;
  private static baseUrl: string = "https://api-connect.supertab.co";
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
        options = { ...options, backend: FASTLY_BACKEND };
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
    licenseToken: string;
    url: string;
    user_agent: string;
  } {
    // Parse token
    const auth = request.headers.get("Authorization") || "";
    const licenseToken = auth.startsWith("License ") ? auth.slice(8) : "";

    // Extract URL and user agent
    const url = request.url;
    const user_agent = request.headers.get("User-Agent") || "unknown";

    return { licenseToken, url, user_agent };
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
    // 1. Extract license token, URL, and user agent from the request
    const { licenseToken, url, user_agent } =
      this.extractDataFromRequest(request);

    // 2. Handle bot detection if provided
    if (botDetectionHandler && !botDetectionHandler(request, ctx)) {
      return new Response("✅ Non-Bot Content Access granted", {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
      });
    }

    // 3. Call the base license handle request method and return the result
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
    resourceUrl: string,
    licenseXml: string
  ): Promise<string> {
    const tokenEndpoint = SupertabConnect.baseUrl + "/rsl/token";
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
}
