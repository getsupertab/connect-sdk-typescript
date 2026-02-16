import {
  SupertabConnectConfig,
  EnforcementMode,
  BotDetector,
  HandlerAction,
  HandlerResult,
  LicenseTokenInvalidReason,
  RSLVerificationResult,
  ExecutionContext,
  Env,
  FastlyHandlerOptions,
} from "./types";
import { obtainLicenseToken as obtainLicenseTokenHelper } from "./customer";
import {
  buildBlockResult,
  buildSignalResult,
  verifyLicenseToken as verifyLicenseTokenHelper,
  verifyAndRecordEvent,
} from "./license";
import {
  handleCloudflareRequest,
  handleFastlyRequest,
  handleCloudfrontRequest,
} from "./cdn";
import {
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudfrontHandlerOptions,
} from "./types";

export { EnforcementMode, HandlerAction, LicenseTokenInvalidReason };
export type {
  SupertabConnectConfig,
  RSLVerificationResult,
  ExecutionContext,
  Env,
  BotDetector,
  HandlerResult,
  FastlyHandlerOptions,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudfrontHandlerOptions,
};
export { defaultBotDetector } from "./bots";

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
export class SupertabConnect {
  private apiKey?: string;
  private static baseUrl: string = "https://api-connect.supertab.co";
  private enforcement!: EnforcementMode;
  private botDetector?: BotDetector;
  private debug!: boolean;

  private static _instance: SupertabConnect | null = null;

  /**
   * Create a new SupertabConnect instance (singleton).
   * Returns the existing instance if one exists with the same config.
   * @param config SDK configuration including apiKey
   * @param reset Pass true to replace an existing instance with different config
   * @throws If an instance with different config already exists and reset is false
   */
  public constructor(config: SupertabConnectConfig, reset: boolean = false) {
    if (!reset && SupertabConnect._instance) {
      // If reset was not requested and an instance conflicts with the provided config, throw an error
      if (config.apiKey !== SupertabConnect._instance.apiKey) {
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

    if (!config.apiKey) {
      throw new Error(
        "Missing required configuration: apiKey is required"
      );
    }
    this.apiKey = config.apiKey;
    this.enforcement = config.enforcement ?? EnforcementMode.SOFT;
    this.botDetector = config.botDetector;
    this.debug = config.debug ?? false;

    // Register this as the singleton instance
    SupertabConnect._instance = this;
  }

  /**
   * Clear the singleton instance, allowing a new one to be created with different config.
   */
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
   * Pure token verification — verifies a license token without recording any events.
   * @param options.token The license token to verify
   * @param options.resourceUrl The URL of the resource being accessed
   * @param options.baseUrl Optional override for the Supertab Connect API base URL
   * @param options.debug Enable debug logging (default: false)
   * @returns A promise that resolves with the verification result
   */
  static async verify(options: {
    token: string;
    resourceUrl: string;
    baseUrl?: string;
    debug?: boolean;
  }): Promise<RSLVerificationResult> {
    const baseUrl = options.baseUrl ?? SupertabConnect.baseUrl;

    const result = await verifyLicenseTokenHelper({
      licenseToken: options.token,
      requestUrl: options.resourceUrl,
      supertabBaseUrl: baseUrl,
      debug: options.debug ?? false,
    });

    if (result.valid) {
      return { valid: true };
    }

    return { valid: false, error: result.error };
  }

  /**
   * Verify a license token and record an analytics event.
   * Uses the instance's apiKey for event recording.
   * @param options.token The license token to verify
   * @param options.resourceUrl The URL of the resource being accessed
   * @param options.userAgent Optional user agent string for event recording
   * @param options.debug Enable debug logging (default: false)
   * @param options.ctx Optional execution context with waitUntil for non-blocking event recording
   * @returns A promise that resolves with the verification result
   */
  async verifyAndRecord(options: {
    token: string;
    resourceUrl: string;
    userAgent?: string;
    debug?: boolean;
    ctx?: ExecutionContext;
  }): Promise<RSLVerificationResult> {
    const result = await verifyAndRecordEvent({
      token: options.token,
      url: options.resourceUrl,
      userAgent: options.userAgent ?? "unknown",
      supertabBaseUrl: SupertabConnect.baseUrl,
      debug: options.debug ?? this.debug,
      apiKey: this.apiKey!,
      ctx: options.ctx,
    });

    if (result.valid) {
      return { valid: true };
    }

    return { valid: false, error: result.error };
  }

  /**
   * Handle an incoming request by extracting the license token, verifying it, and recording an analytics event.
   * When no token is present, bot detection and enforcement mode determine the response.
   * @param request The incoming HTTP request
   * @param ctx Execution context for non-blocking event recording.
   *   Pass this from your platform (e.g. Cloudflare Workers)
   * @returns A promise that resolves with the handler result indicating ALLOW or  BLOCK request
   */
  async handleRequest(request: Request, ctx?: ExecutionContext): Promise<HandlerResult> {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("License ") ? auth.slice(8) : null;
    const url = request.url;
    const userAgent = request.headers.get("User-Agent") || "unknown";

    // Token present → ALWAYS validate, regardless of mode or bot detection
    if (token) {
      if (this.enforcement === EnforcementMode.DISABLED) {
        return { action: HandlerAction.ALLOW };
      }
      const verification = await verifyAndRecordEvent({
        token,
        url,
        userAgent,
        supertabBaseUrl: SupertabConnect.baseUrl,
        debug: this.debug,
        apiKey: this.apiKey!,
        ctx,
      });
      if (!verification.valid) {
        return buildBlockResult({
          reason: verification.reason,
          error: verification.error,
          requestUrl: url,
        });
      }
      return { action: HandlerAction.ALLOW };
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
          error: "Authorization header missing or malformed",
          requestUrl: url,
        });
      case EnforcementMode.SOFT:
        return buildSignalResult(url);
      default: // DISABLED
        return { action: HandlerAction.ALLOW };
    }
  }

  /**
   * Request a license token from the Supertab Connect token endpoint.
   * @param options.clientId OAuth client identifier.
   * @param options.clientSecret OAuth client secret for client_credentials flow.
   * @param options.resourceUrl Resource URL attempting to access with a License.
   * @param options.debug Enable debug logging (default: false).
   * @returns Promise resolving to the issued license access token string.
   */
  static async obtainLicenseToken(options: {
    clientId: string;
    clientSecret: string;
    resourceUrl: string;
    debug?: boolean;
  }): Promise<string> {
    return obtainLicenseTokenHelper({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      resourceUrl: options.resourceUrl,
      debug: options.debug,
    });
  }

  /**
   * Handle incoming requests for Cloudflare Workers.
   * Pass this directly as your Worker's fetch handler.
   * @param request The incoming Worker request
   * @param env Worker environment bindings containing MERCHANT_API_KEY
   * @param ctx Worker execution context for non-blocking event recording
   * @param options Optional configuration items
   * @param options.botDetector Custom bot detection function
   * @param options.enforcement Enforcement mode (default: SOFT)
   */
  static async cloudflareHandleRequests(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    options?: {
       botDetector?: BotDetector;
       enforcement?: EnforcementMode;
    }
  ): Promise<Response> {
    try {
      const instance = new SupertabConnect({
        apiKey: env.MERCHANT_API_KEY,
        botDetector: options?.botDetector,
        enforcement: options?.enforcement,
      });
      return await handleCloudflareRequest(instance, request, ctx);
    } catch (err) {
      console.error("[SupertabConnect] cloudflareHandleRequests failed:", err);
      return await fetch(request);
    }
  }

  /**
   * Handle incoming requests for Fastly Compute.
   * @param request The incoming Fastly request
   * @param merchantApiKey The merchant API key for authentication
   * @param originBackend The Fastly backend name to forward allowed requests to
   * @param options Optional configuration items
   * @param options.enableRSL Serve license.xml at /license.xml for RSL-compliant clients (default: false)
   * @param options.merchantSystemUrn Required when enableRSL is true; the merchant system URN used to fetch license.xml
   * @param options.botDetector Custom bot detection function
   * @param options.enforcement Enforcement mode (default: SOFT)
   */
  static async fastlyHandleRequests(
    request: Request,
    merchantApiKey: string,
    originBackend: string,
    options?: FastlyHandlerOptions
  ): Promise<Response> {
    try {
      const { botDetector, enforcement } = options ?? {};

      const instance = new SupertabConnect({
        apiKey: merchantApiKey,
        botDetector,
        enforcement,
      });

      let rslOptions: { baseUrl: string; merchantSystemUrn: string } | undefined;
      if (options?.enableRSL) {
        rslOptions = {
          baseUrl: SupertabConnect.baseUrl,
          merchantSystemUrn: options.merchantSystemUrn,
        };
      }

      return await handleFastlyRequest(
        instance,
        request,
        originBackend,
        rslOptions
      );
    } catch (err) {
      console.error("[SupertabConnect] fastlyHandleRequests failed:", err);
      return await fetch(request, { backend: originBackend } as RequestInit);
    }
  }

  /**
   * Handle incoming requests for AWS CloudFront Lambda@Edge.
   * Use as the handler for a viewer-request LambdaEdge function.
   * @param event The CloudFront viewer-request event
   * @param options Configuration including apiKey and optional botDetector/enforcement
   */
  static async cloudfrontHandleRequests<TRequest extends Record<string, any>>(
    event: CloudFrontRequestEvent<TRequest>,
    options: CloudfrontHandlerOptions
  ): Promise<CloudFrontRequestResult<TRequest>> {
    try {
      const instance = new SupertabConnect({
        apiKey: options.apiKey,
        botDetector: options.botDetector,
        enforcement: options.enforcement,
      });
      return await handleCloudfrontRequest(instance, event);
    } catch (err) {
      console.error("[SupertabConnect] cloudfrontHandleRequests failed:", err);
      return event?.Records?.[0]?.cf?.request as TRequest ?? {} as CloudFrontRequestResult<TRequest>;
    }
  }
}
