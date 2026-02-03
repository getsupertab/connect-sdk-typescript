import {
  SupertabConnectConfig,
  EnforcementMode,
  BotDetector,
  HandlerAction,
  HandlerResult,
  EventPayload,
  Env,
  FASTLY_BACKEND,
  LicenseTokenInvalidReason,
  LicenseTokenVerificationResult,
} from "./types";
import { obtainLicenseToken as obtainLicenseTokenHelper } from "./customer";
import {
  buildBlockResult,
  buildSignalResult,
  verifyLicenseToken as verifyLicenseTokenHelper,
  validateTokenAndBuildResult,
} from "./license";
import {
  cloudflareHandleRequests as cloudflareHandler,
  fastlyHandleRequests as fastlyHandler,
} from "./cdn";

export { EnforcementMode, HandlerAction };
export type { Env, BotDetector, HandlerResult } from "./types";
export { defaultBotDetector } from "./bots";

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
export class SupertabConnect {
  private apiKey?: string;
  private static baseUrl: string = "https://api-connect.supertab.co";
  private merchantSystemUrn!: string;
  private enforcement!: EnforcementMode;
  private botDetector?: BotDetector;
  private debug!: boolean;

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
    this.enforcement = config.enforcement ?? EnforcementMode.SOFT;
    this.botDetector = config.botDetector;
    this.debug = config.debug ?? false;

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
   * Get the current base URL for API requests.
   */
  public static getBaseUrl(): string {
    return SupertabConnect.baseUrl;
  }

  /**
   * Verify a license token
   * @param licenseToken The license token to verify
   * @param requestUrl The URL of the request being made
   * @returns A promise that resolves with the verification result
   */
  async verifyLicenseToken(
    licenseToken: string,
    requestUrl: string
  ): Promise<LicenseTokenVerificationResult> {
    return verifyLicenseTokenHelper({
      licenseToken,
      requestUrl,
      supertabBaseUrl: SupertabConnect.baseUrl,
      debug: this.debug,
    });
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

  async handleRequest(request: Request, ctx?: any): Promise<HandlerResult> {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("License ") ? auth.slice(8) : null;
    const url = request.url;
    const userAgent = request.headers.get("User-Agent") || "unknown";

    // Token present → ALWAYS validate, regardless of mode or bot detection
    if (token) {
      if (this.enforcement === EnforcementMode.DISABLED) {
        return { action: HandlerAction.ALLOW };
      }
      return validateTokenAndBuildResult({
        token,
        url,
        userAgent,
        supertabBaseUrl: SupertabConnect.baseUrl,
        debug: this.debug,
        recordEvent: this.recordEvent.bind(this),
        ctx,
      });
    }

    // No token from here on
    const isBot = this.botDetector?.(request, ctx) ?? false;

    if (!isBot) {
      return { action: HandlerAction.ALLOW };
    }

    // Bot detected, no token — enforcement mode decides
    switch (this.enforcement) {
      case EnforcementMode.STRICT:
        return buildBlockResult({
          reason: LicenseTokenInvalidReason.MISSING_TOKEN,
          requestUrl: url,
          supertabBaseUrl: SupertabConnect.baseUrl,
        });
      case EnforcementMode.SOFT:
        return buildSignalResult(url);
      default: // DISABLED
        return { action: HandlerAction.ALLOW };
    }
  }

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
  static async obtainLicenseToken(
    clientId: string,
    clientSecret: string,
    resourceUrl: string,
    debug: boolean = false
  ): Promise<string> {
    return obtainLicenseTokenHelper({
      clientId,
      clientSecret,
      resourceUrl,
      debug,
    });
  }

  /**
   * Handle requests in Cloudflare Workers environment.
   */
  static cloudflareHandleRequests(
    request: Request,
    env: Env,
    ctx: any
  ): Promise<Response> {
    return cloudflareHandler(request, env, ctx);
  }

  /**
   * Handle requests in Fastly Compute environment.
   */
  static fastlyHandleRequests(
    request: Request,
    merchantSystemUrn: string,
    merchantApiKey: string,
    originBackend: string,
    options?: {
      enableRSL?: boolean;
      botDetector?: BotDetector;
      enforcement?: EnforcementMode;
    }
  ): Promise<Response> {
    return fastlyHandler(
      request,
      merchantSystemUrn,
      merchantApiKey,
      originBackend,
      options
    );
  }
}
