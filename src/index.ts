import {
  SupertabConnectConfig,
  EnforcementMode,
  BotDetector,
  HandlerAction,
  HandlerResult,
  LicenseTokenInvalidReason,
  CDNStatusDescription,
  RSLVerificationResult,
  ExecutionContext,
  Env,
  FastlyHandlerOptions,
  FastlyFetchEvent,
} from "./types";
import {
  obtainLicenseToken as obtainLicenseTokenHelper,
  UsageType,
} from "./customer";
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
  HandleRequestContext,
} from "./cdn";
import { verifyStatusChallenge } from "./status";
import { SDK_VERSION } from "./version";
import {
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudfrontHandlerOptions,
} from "./types";
import {
  AnalyticsEvent,
  AnalyticsTransport,
  Decision,
  TOKEN_OUTCOME_BY_REASON,
  TokenOutcome,
} from "./analytics/types";
import {
  ANALYTICS_EVENTS_PATH,
  HttpAnalyticsTransport,
  NoopAnalyticsTransport,
  selectFastlyAnalyticsTransport,
} from "./analytics/transport";
import { buildAnalyticsEvent } from "./analytics/buildAnalyticsEvent";
import { resolveFastlyClientSignals } from "./fastly-signals";

export {
  EnforcementMode,
  HandlerAction,
  LicenseTokenInvalidReason,
  CDNStatusDescription,
  UsageType,
};
export type {
  SupertabConnectConfig,
  RSLVerificationResult,
  ExecutionContext,
  Env,
  BotDetector,
  HandlerResult,
  FastlyHandlerOptions,
  FastlyFetchEvent,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
  CloudfrontHandlerOptions,
  AnalyticsEvent,
  AnalyticsTransport,
};
export { defaultBotDetector } from "./bots";
export { selectFastlyAnalyticsTransport } from "./analytics/transport";

const LICENSE_PREFIX = "License ";

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
  private analyticsTransport!: AnalyticsTransport;
  private analyticsEnabled!: boolean;

  private static _instance: SupertabConnect | null = null;

  /**
   * Create a new SupertabConnect instance (singleton).
   * Returns the existing instance if one exists with the same config.
   * @param config SDK configuration including apiKey
   * @param reset Pass true to replace an existing instance with different config
   * @throws If an instance with different config already exists and reset is false
   */
  public constructor(config: SupertabConnectConfig, reset: boolean = false) {
    // Warn before any early-return so the message fires regardless of singleton state.
    const c = config as unknown as Record<string, unknown>;
    if (c["logEndpoint"] !== undefined || c["merchantSystemUrn"] !== undefined) {
      console.warn(
        "[SupertabConnect] logEndpoint/merchantSystemUrn are not constructor options — " +
        "pass them to fastlyHandleRequests, or use selectFastlyAnalyticsTransport directly."
      );
    }

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
    this.enforcement = config.enforcement ?? EnforcementMode.OBSERVE;
    this.botDetector = config.botDetector;
    this.debug = config.debug ?? false;
    this.analyticsEnabled = config.analyticsEnabled ?? false;
    this.analyticsTransport = SupertabConnect.buildAnalyticsTransport(config);

    // Register this as the singleton instance
    SupertabConnect._instance = this;
  }

  private static buildAnalyticsTransport(config: SupertabConnectConfig): AnalyticsTransport {
    if (config.analyticsTransport) {
      return config.analyticsTransport;
    }
    if (!config.analyticsEnabled) {
      return new NoopAnalyticsTransport();
    }
    return new HttpAnalyticsTransport({
      url: `${SupertabConnect.baseUrl}${ANALYTICS_EVENTS_PATH}`,
      apiKey: config.apiKey,
      debug: config.debug ?? false,
    });
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
   * @param options.requestHeaders Optional request headers to include in the event properties
   * @param options.debug Enable debug logging (default: false)
   * @param options.ctx Optional execution context with waitUntil for non-blocking event recording
   * @returns A promise that resolves with the verification result
   */
  async verifyAndRecord(options: {
    token: string;
    resourceUrl: string;
    userAgent?: string;
    requestHeaders?: Record<string, string>;
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
      requestHeaders: options.requestHeaders,
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
   * @param context CDN-supplied request context (sourceCdn, clientIp, ctx, requestId)
   * @returns A promise that resolves with the handler result indicating ALLOW or BLOCK
   */
  async handleRequest(request: Request, context?: HandleRequestContext): Promise<HandlerResult> {
    // Cheap substring pre-filter so the common request path skips URL parsing.
    if (request.url.includes("/.well-known/supertab/status")) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/supertab/status") {
        const authHeader = request.headers.get("Authorization") ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        const ok = token
          ? await verifyStatusChallenge(token, {
              expectedAudience: url.origin,
              baseUrl: SupertabConnect.getBaseUrl(),
              debug: this.debug,
            })
          : false;
        if (!ok) {
          return {
            action: HandlerAction.RESPOND,
            status: 404,
            body: JSON.stringify({ supertab: true }),
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          };
        }
        // merchantUrn is omitted until it is plumbed through HandleRequestContext or an instance field.
        const body = JSON.stringify({
          runtime: context?.sourceCdn ?? null,
          sdkVersion: SDK_VERSION,
          enforcement: this.enforcement,
          eventReporting: this.analyticsEnabled,
        });
        return {
          action: HandlerAction.RESPOND,
          status: 200,
          body,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        };
      }
    }

    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith(LICENSE_PREFIX) ? auth.slice(LICENSE_PREFIX.length) : null;
    const hasToken = token !== null;
    const rawUrl = request.url;
    const userAgent = request.headers.get("User-Agent") || "unknown";

    const requestId = context?.requestId ?? crypto.randomUUID();
    const sourceCdn = context?.sourceCdn ?? null;
    const clientIp = context?.clientIp;
    const ctx = context?.ctx;
    const requestCountry = context?.requestCountry;
    const requestAsn = context?.requestAsn;
    const tlsFingerprint = context?.tlsFingerprint;
    const cdnSignals = context?.cdnSignals;

    const emit = (decision: Decision): void => {
      try {
        const event = buildAnalyticsEvent(request, decision, {
          requestId,
          sourceCdn,
          clientIp,
          requestCountry,
          requestAsn,
          tlsFingerprint,
          cdnSignals,
        });
        this.analyticsTransport.emit(event, ctx);
      } catch (err) {
        if (this.debug) {
          console.error("[SupertabConnect] failed to build/emit analytics event:", err);
        }
      }
    };

    // Token present → validate, regardless of bot detection — except in DISABLED
    // mode, which short-circuits to ALLOW without verification.
    if (token) {
      if (this.enforcement === EnforcementMode.DISABLED) {
        // DISABLED short-circuits to ALLOW without verifying the token, so we
        // cannot honestly claim "valid". Emit "not_validated" so the token is
        // not counted as a licensed request in analytics.
        emit({
          hasToken,
          tokenOutcome: "not_validated",
          finalAction: "allow",
          enforcementMode: this.enforcement,
        });
        return { action: HandlerAction.ALLOW };
      }
      const verification = await verifyAndRecordEvent({
        token,
        url: rawUrl,
        userAgent,
        supertabBaseUrl: SupertabConnect.baseUrl,
        debug: this.debug,
        apiKey: this.apiKey!,
        ctx,
        requestHeaders: Object.fromEntries(request.headers.entries()),
      });
      const tokenOutcome: TokenOutcome = verification.valid
        ? "valid"
        : TOKEN_OUTCOME_BY_REASON[verification.reason as LicenseTokenInvalidReason] ?? "malformed";

      if (!verification.valid) {
        emit({
          hasToken,
          tokenOutcome,
          finalAction: "block",
          enforcementMode: this.enforcement,
        });
        return buildBlockResult({
          reason: verification.reason,
          error: verification.error,
          requestUrl: rawUrl,
        });
      }
      emit({
        hasToken,
        tokenOutcome,
        finalAction: "allow",
        enforcementMode: this.enforcement,
      });
      return { action: HandlerAction.ALLOW };
    }

    // No token from here on
    const isBot = this.botDetector?.(request, ctx) ?? false;

    if (!isBot) {
      emit({
        hasToken,
        tokenOutcome: "absent",
        finalAction: "allow",
        enforcementMode: this.enforcement,
      });
      return { action: HandlerAction.ALLOW };
    }

    // Bot detected, no token — enforcement mode decides
    switch (this.enforcement) {
      case EnforcementMode.ENFORCE:
        emit({
          hasToken,
          tokenOutcome: "absent",
          finalAction: "block",
          enforcementMode: this.enforcement,
        });
        return buildBlockResult({
          reason: LicenseTokenInvalidReason.MISSING_TOKEN,
          error: "Authorization header missing or malformed",
          requestUrl: rawUrl,
        });
      case EnforcementMode.OBSERVE:
        emit({
          hasToken,
          tokenOutcome: "absent",
          finalAction: "observe",
          enforcementMode: this.enforcement,
        });
        return buildSignalResult(rawUrl);
      default: // DISABLED
        emit({
          hasToken,
          tokenOutcome: "absent",
          finalAction: "allow",
          enforcementMode: this.enforcement,
        });
        return { action: HandlerAction.ALLOW };
    }
  }

  /**
   * Request a license token from the Supertab Connect token endpoint.
   * If usage type is specified and matching serverless content permits it, skips token request and returns undefined.
   * @param options.clientId OAuth client identifier.
   * @param options.clientSecret OAuth client secret for client_credentials flow.
   * @param options.resourceUrl Resource URL attempting to access with a License.
   * @param options.usage Optional usage type.
   *   If specified and a matching serverless content exists in license, no token is issued
   * @param options.debug Enable debug logging (default: false).
   * @returns Promise resolving to the issued license access token string, or `undefined` when no token is needed.
   */
  static async obtainLicenseToken(options: {
    clientId: string;
    clientSecret: string;
    resourceUrl: string;
    usage?: UsageType;
    debug?: boolean;
  }): Promise<string | undefined> {
    return obtainLicenseTokenHelper({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      resourceUrl: options.resourceUrl,
      usage: options.usage,
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
   * @param options.enforcement Enforcement mode (default: OBSERVE)
   * @param options.analyticsEnabled Toggle relay analytics emission (default: false)
   * @param options.originUrl Override the upstream origin for ALLOW/OBSERVE pass-through.
   *   When set, the Worker's `fetch` for forwarded traffic targets `${originUrl}${path}${query}`
   *   instead of `request.url`. License audience / resource verification still uses `request.url`,
   *   so the Worker URL clients hit and the origin URL the Worker forwards to can differ.
   *   Production Cloudflare deployments using Workers Routes can omit this — `fetch(request)`
   *   already resolves to the origin via Cloudflare's edge.
   */
  static async cloudflareHandleRequests(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    options?: {
       botDetector?: BotDetector;
       enforcement?: EnforcementMode;
       analyticsEnabled?: boolean;
       originUrl?: string;
    }
  ): Promise<Response> {
    try {
      const instance = new SupertabConnect({
        apiKey: env.MERCHANT_API_KEY,
        botDetector: options?.botDetector,
        enforcement: options?.enforcement,
        analyticsEnabled: options?.analyticsEnabled,
      });
      return await handleCloudflareRequest(instance, request, ctx, options?.originUrl);
    } catch (err) {
      console.error("[SupertabConnect] cloudflareHandleRequests failed:", err);
      return await fetch(request);
    }
  }

  /**
   * Handle incoming requests for Fastly Compute.
   * @param event The Fastly `FetchEvent`. Viewer IP/geo/JA3 are resolved internally: on a
   *   VCL→Compute chain from the `Fastly-Client-IP` header + `fastly:geolocation` (JA3 dropped),
   *   otherwise from `event.client`. See `resolveFastlyClientSignals`.
   * @param merchantApiKey The merchant API key for authentication
   * @param originBackend The Fastly backend name to forward allowed requests to
   * @param options Optional configuration items
   * @param options.enableRSL Serve license.xml at /license.xml for RSL-compliant clients (default: false)
   * @param options.botDetector Custom bot detection function
   * @param options.enforcement Enforcement mode (default: OBSERVE)
   * @param options.analyticsEnabled Toggle relay analytics emission (default: false)
   */
  static async fastlyHandleRequests(
    event: FastlyFetchEvent,
    merchantApiKey: string,
    originBackend: string,
    options: FastlyHandlerOptions = {}
  ): Promise<Response> {
    const request = event.request;
    try {
      const { botDetector, enforcement, analyticsEnabled, merchantSystemUrn, logEndpoint } = options;

      // Fastly owns its transport choice here, rather than the shared constructor sniffing
      // globalThis.fastly: native bot-events logging when opted in, else the constructor's relay.
      const instance = new SupertabConnect({
        apiKey: merchantApiKey,
        botDetector,
        enforcement,
        analyticsEnabled,
        analyticsTransport: selectFastlyAnalyticsTransport({
          analyticsEnabled,
          logEndpoint,
          merchantSystemUrn,
        }),
      });

      let rslOptions: { baseUrl: string; merchantSystemUrn: string } | undefined;
      if (options?.enableRSL) {
        rslOptions = {
          baseUrl: SupertabConnect.baseUrl,
          merchantSystemUrn: options.merchantSystemUrn,
        };
      }
  
      const clientSignals = await resolveFastlyClientSignals(event);
      // Bridge FetchEvent.waitUntil to the analytics ExecutionContext so post-response
      // emits are held until they settle (the BLOCK path has no origin fetch to do so).
      const ctx: ExecutionContext = { waitUntil: (promise) => event.waitUntil(promise) };
      return await handleFastlyRequest(
        instance,
        request,
        originBackend,
        rslOptions,
        clientSignals,
        ctx
      );
    } catch (err) {
      console.error("[SupertabConnect] fastlyHandleRequests failed:", err);
      return await fetch(request, { backend: originBackend } as RequestInit);
    }
  }

  /**
   * Handle incoming requests for AWS CloudFront Lambda@Edge.
   * Use as the handler for an origin-request LambdaEdge function.
   * @param event The CloudFront origin-request event
   * @param options Configuration including apiKey and optional botDetector/enforcement fields.
   *   Relay analytics is not supported on CloudFront — only Cloudflare and Fastly emit events.
   */
  static async cloudfrontHandleRequests<TRequest extends Record<string, any>>(
    event: CloudFrontRequestEvent<TRequest>,
    options: CloudfrontHandlerOptions
  ): Promise<CloudFrontRequestResult<TRequest>> {
    const request = event?.Records?.[0]?.cf?.request as TRequest ?? {} as CloudFrontRequestResult<TRequest>;
    try {
      // The self-report status probe carries an Authorization: Bearer challenge, not
      // x-license-auth, so it must be let through to handleRequest rather than passed to origin.
      const isStatusProbe = request.uri === "/.well-known/supertab/status";
      const license_auth_header = request.headers?.["x-license-auth"];
      if (!license_auth_header && !isStatusProbe) {
        // No license auth header means the request is either from a human or from an unidentifiable bot.
        // No reasons to waste compute resources on the rest of the checks.
        return request;
      }
      // Relay analytics is intentionally not wired for CloudFront yet (Cloudflare and Fastly only);
      // the instance is built without analytics so it uses the no-op transport.
      const instance = new SupertabConnect({
        apiKey: options.apiKey,
        botDetector: options.botDetector,
        enforcement: options.enforcement,
      });
      return await handleCloudfrontRequest(instance, event);
    } catch (err) {
      console.error("[SupertabConnect] cloudfrontHandleRequests failed:", err);
      return request;
    }
  }
}
