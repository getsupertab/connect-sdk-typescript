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
  StatusSource,
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
import { getConnectBackend, setConnectBackend } from "./fastly-backend";

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
export { DEFAULT_BACKGROUND_WORK_TIMEOUT_MS } from "./cdn";

const LICENSE_PREFIX = "License ";

/**
 * SupertabConnect class provides higher level methods
 * for using Supertab Connect within supported CDN integrations
 * as well as more specialized methods to customarily verify JWT tokens and record events.
 */
export class SupertabConnect {
  private apiKey?: string;
  private static baseUrl: string = "https://api-connect.supertab.co";
  // Analytics is served by the dedicated ingest service, not the API host. Kept as a
  // separate static (mirroring baseUrl/setBaseUrl) so the relay can be pointed at a
  // different host — or at localhost in dev — without moving token/JWKS/verify traffic.
  private static analyticsBaseUrl: string = "https://ingest-connect.supertab.co";
  private enforcement!: EnforcementMode;
  private botDetector?: BotDetector;
  private debug!: boolean;
  private analyticsTransport!: AnalyticsTransport;
  private analyticsEnabled!: boolean;

  private static _instance: SupertabConnect | null = null;

  /**
   * Create a new SupertabConnect instance (singleton).
   * If an instance with the same apiKey already exists it is returned UNCHANGED —
   * options are applied only on first construction (instances are never mutated after
   * creation, so in-flight requests always see a consistent configuration). Use
   * `resetInstance()` (or `reset: true`) to build one with different options.
   * @param config SDK configuration including apiKey
   * @param reset Pass true to replace an existing instance with different config
   * @throws If an instance with a different apiKey already exists and reset is false
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

      // Same apiKey: return the existing instance unchanged. Deployed handlers pass the
      // same static options on every invocation, so the first construction is
      // authoritative; mutating the shared instance here would let one caller's options
      // leak into another caller's in-flight request.
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
    // A custom transport emits regardless of the flag, so report it as enabled.
    this.analyticsEnabled = (config.analyticsEnabled ?? false) || config.analyticsTransport != null;
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
    const analyticsBaseUrl = config.analyticsBaseUrl ?? SupertabConnect.analyticsBaseUrl;
    return new HttpAnalyticsTransport({
      url: `${analyticsBaseUrl}${ANALYTICS_EVENTS_PATH}`,
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
   * Override the Fastly backend carrying the SDK's own Connect-API calls — license.xml,
   * JWKS, events, analytics (default: `stc-backend`). `fastlyHandleRequests` sets this from
   * its `connectBackend` option; call it directly when using `verify` outside that handler.
   * Does not cover `obtainLicenseToken`, whose token request names no backend at all.
   * No effect off Fastly. Pass undefined to restore the default.
   */
  public static setConnectBackend(name: string | undefined): void {
    setConnectBackend(name);
  }

  /**
   * Get the Fastly backend name used for the SDK's own Connect-API calls.
   */
  public static getConnectBackend(): string {
    return getConnectBackend();
  }

  /**
   * Override the base URL of the analytics ingest relay (e.g. for a non-prod environment
   * or local development). Independent of setBaseUrl — token/JWKS/verify traffic is
   * unaffected. Can also be set per-instance via the `analyticsBaseUrl` config option.
   */
  public static setAnalyticsBaseUrl(url: string): void {
    SupertabConnect.analyticsBaseUrl = url;
  }

  /**
   * Get the current base URL of the analytics ingest relay.
   */
  public static getAnalyticsBaseUrl(): string {
    return SupertabConnect.analyticsBaseUrl;
  }

  /**
   * Pure token verification — verifies a license token without recording any events.
   * @param options Verification inputs.
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
   * @param options Verification and event-recording inputs.
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
   * @param context CDN-supplied request context. Omitted entirely when the SDK is invoked
   *   directly rather than from a CDN handler.
   * @param context.ctx Execution context whose `waitUntil` holds the runtime open for the
   *   analytics emit and event recording.
   * @param context.sourceCdn Which CDN handled the request; omitted when there was none.
   * @param context.clientIp The viewer address as the CDN resolved it.
   * @param context.clientIpSource Provenance of `clientIp`. Only whoever resolved the address
   *   can assert this; omitting it leaves the column NULL rather than having the SDK guess.
   * @param context.deferAnalytics Hold the ALLOW analytics event back until the caller reports
   *   the response, so it can carry a real status code. Honoured only when `ctx` is present;
   *   opting in means you MUST call the returned `reportResponse` from a `finally`.
   * @param context.requestId Correlation id for the event; a UUID is generated when absent.
   * @param context.requestCountry Viewer country from the CDN's geo lookup.
   * @param context.requestAsn Viewer ASN from the CDN's geo lookup.
   * @param context.tlsFingerprint Viewer JA3/JA4 TLS fingerprint, when the CDN exposes one.
   * @param context.cdnSignals CDN plumbing not derivable from the portable `Request`.
   * @returns A promise that resolves with the handler result indicating ALLOW or BLOCK
   */
  async handleRequest(request: Request, context?: HandleRequestContext): Promise<HandlerResult> {
    const ctx = context?.ctx;
    // Deferral is honoured only when there is an ExecutionContext to hold the runtime open.
    // Nothing new lands on the request path either way — the emit is already fire-and-forget
    // and a response's status arrives with its headers — but a deferred emit *starts* as the
    // response is returned, so without waitUntil it is likelier to be dropped than an eager
    // one. Falling back to an eager emit trades the status for delivery, and says so in
    // status_source rather than leaving a null nothing can read.
    const deferring = context?.deferAnalytics === true && ctx !== undefined;

    const requestId = context?.requestId ?? crypto.randomUUID();
    const send = (decision: Decision, statusCode: number | null, statusSource: StatusSource): void => {
      try {
        const event = buildAnalyticsEvent(request, decision, {
          requestId,
          sourceCdn: context?.sourceCdn ?? null,
          clientIp: context?.clientIp,
          clientIpSource: context?.clientIpSource,
          statusCode,
          statusSource,
          requestCountry: context?.requestCountry,
          requestAsn: context?.requestAsn,
          tlsFingerprint: context?.tlsFingerprint,
          cdnSignals: context?.cdnSignals,
        });
        this.analyticsTransport.emit(event, ctx);
      } catch (err) {
        if (this.debug) {
          console.error("[SupertabConnect] failed to build/emit analytics event:", err);
        }
      }
    };

    // Always held until decide() returns, so the event carries whatever is known by then.
    // Every decide() path still calls emit() exactly where it always did; only the sending
    // moves. Only an allowed request has anything left to wait for.
    let pending: Decision | null = null;
    const emit = (decision: Decision): void => {
      pending = decision;
    };
    // Taken on the way out so a second report is a no-op rather than a duplicate row, and a
    // path that never emitted (the status probe) reports nothing.
    const take = (): Decision | null => {
      const decision = pending;
      pending = null;
      return decision;
    };

    let result: HandlerResult;
    try {
      result = await this.decide(request, context, emit);
    } catch (err) {
      // decide() emits before it builds its result, so a throw in between would otherwise
      // drop an event that would have been sent had it been emitted eagerly.
      const decision = take();
      if (decision !== null) send(decision, null, "unobserved");
      throw err;
    }

    if (result.action !== HandlerAction.ALLOW) {
      // The status is ours and already decided — nothing to wait for, deferring or not.
      const decision = take();
      if (decision !== null) send(decision, result.status, "observed");
      return result;
    }

    if (!deferring) {
      const decision = take();
      if (decision !== null) send(decision, null, "unobserved");
      return result;
    }

    result.reportResponse = (status: number | null, source?: StatusSource): void => {
      const decision = take();
      if (decision === null) return;
      send(decision, status, status !== null ? "observed" : (source ?? "unobserved"));
    };
    return result;
  }

  /**
   * The enforcement decision itself. Split out so the public entry point has one exit at
   * which to attach the response reporter — every emit() call below stays where it was.
   * @param request The incoming HTTP request.
   * @param context CDN-supplied request context, as passed to `handleRequest`.
   * @param emit Reporter invoked with the decision once it is made, so the caller owns
   *   whether the analytics event is sent eagerly or deferred until the response is known.
   * @returns A promise that resolves with the handler result indicating ALLOW or BLOCK.
   */
  private async decide(
    request: Request,
    context: HandleRequestContext | undefined,
    emit: (decision: Decision) => void
  ): Promise<HandlerResult> {
    // Cheap substring pre-filter so the common request path skips URL parsing.
    if (request.url.includes("/.well-known/supertab/status")) {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/supertab/status" && request.method === "GET") {
        const authHeader = request.headers.get("Authorization") ?? "";
        // The auth-scheme is case-insensitive per RFC 9110, and 1+ spaces may follow it.
        const bearerMatch = authHeader.match(/^Bearer +(.+)$/i);
        const token = bearerMatch ? bearerMatch[1] : "";
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
          component: { kind: "ts-sdk", version: SDK_VERSION },
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

    const ctx = context?.ctx;

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
   *
   * The request always carries client credentials + the resource URL, and takes one of two lanes:
   * - RSL License path: the merchant's live public license.xml still has a `<content>` block
   *   matching the resource. The `<license>` chunk is sent to that block's own URN-scoped
   *   `{server}/token` endpoint, keeping the flow RSL-standards compliant.
   * - Agreement path: no block matches. The chunk is omitted and the request goes license-less to
   *   the generic `{baseUrl}/token` endpoint, where the backend resolves the merchant system from
   *   the resource URL and the customer's single Active Agreement and mints against that
   *   Agreement's pinned license snapshot. Entitlement is decided server-side, so a diverged
   *   license.xml that no longer grants the resource never vetoes the request client-side.
   * @param options Token request inputs.
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
    return obtainLicenseTokenHelper(
      {
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        resourceUrl: options.resourceUrl,
        usage: options.usage,
        debug: options.debug,
      },
      SupertabConnect.baseUrl
    );
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
   * @returns The origin response for allowed traffic, or the SDK's block/challenge response.
   *   Never throws — on an internal error the request is forwarded to the origin unchanged.
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
   * @param options.merchantSystemUrn Merchant system URN stamped onto Fastly analytics rows.
   *   Required when `enableRSL`, and for native Fastly logging alongside `logEndpoint`;
   *   without it analytics falls back to the HTTP relay.
   * @param options.logEndpoint Named Fastly logging endpoint to emit bot events to — must match
   *   the endpoint configured on the Fastly service. Set it to enable native Fastly logging;
   *   without it analytics falls back to the HTTP relay.
   * @param options.connectBackend Backend carrying the SDK's own Connect-API calls — license.xml,
   *   JWKS, events, analytics (default: `stc-backend`). Set it when the service names that backend
   *   differently. Distinct from `originBackend`, which carries viewer traffic to your origin.
   * @returns The origin response for allowed traffic, the license.xml response when `enableRSL`
   *   and the path matches, or the SDK's block/challenge response. Never throws — on an internal
   *   error the request is forwarded to `originBackend` unchanged.
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

      // Before the instance is built, so the first Connect-API call already routes correctly.
      setConnectBackend(options.connectBackend);

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
   * Works at either trigger, auto-detected from the event's `config.eventType`: attached at
   * viewer-request it runs pre-cache on every request (full analytics coverage, no CloudFront
   * Function needed); attached at origin-request it only processes requests the CloudFront
   * Function stamped with `x-license-auth` (plus the status probe).
   * @param event The CloudFront request event (viewer-request or origin-request)
   * @param options Configuration including apiKey and optional botDetector/enforcement/debug fields.
   * @param options.apiKey Merchant API key used to authenticate licensing and analytics calls.
   * @param options.botDetector Override for the bot-detection predicate (default:
   *   `defaultBotDetector`).
   * @param options.enforcement Enforcement mode deciding whether unlicensed bots are blocked
   *   or only signalled (default: the SDK's own default mode).
   * @param options.debug Enable debug logging (default: false).
   * @param options.analyticsEnabled Toggle relay analytics emission (default: false). Lambda@Edge
   *   has no `waitUntil`, so the emit is awaited before the response returns —
   *   see CloudfrontHandlerOptions.
   * @param options.analyticsBaseUrl Base URL of the analytics ingest relay, for non-prod
   *   deployments (default: the prod ingest service).
   * @param options.backgroundWorkTimeoutMs Absolute budget (ms) from handler entry for the
   *   background work (analytics emit + legacy event recording); in-flight calls are aborted
   *   at the deadline. Default: `DEFAULT_BACKGROUND_WORK_TIMEOUT_MS` (2000ms); pass `Infinity`
   *   to await to completion.
   * @returns The pass-through request, or a CloudFront response when the request is blocked
   *   or answered by the SDK (status probe, license XML). Never throws — on an internal error
   *   the original request is returned unchanged.
   */
  static async cloudfrontHandleRequests<TRequest extends Record<string, any>>(
    event: CloudFrontRequestEvent<TRequest>,
    options: CloudfrontHandlerOptions
  ): Promise<CloudFrontRequestResult<TRequest>> {
    const request = event?.Records?.[0]?.cf?.request as TRequest ?? {} as CloudFrontRequestResult<TRequest>;
    try {
      // The self-report status probe carries an Authorization: Bearer challenge, not
      // x-license-auth, so it must be let through to handleRequest rather than passed to origin.
      const isStatusProbe = request.uri === "/.well-known/supertab/status" && request.method === "GET";
      const license_auth_header = request.headers?.["x-license-auth"];
      // At viewer-request there is no CloudFront Function ahead of us to stamp
      // x-license-auth (AWS forbids both on one event), and the trigger fires pre-cache on
      // ALL traffic — so every request is processed there, gated only at origin-request.
      const cfConfig = event?.Records?.[0]?.cf?.config;
      const processAll = cfConfig?.eventType === "viewer-request";
      if (!processAll && !license_auth_header && !isStatusProbe) {
        // No license auth header means the request is either from a human or from an unidentifiable bot.
        // No reasons to waste compute resources on the rest of the checks.
        return request;
      }
      // Analytics uses the HTTP relay (no injected transport). Lambda@Edge has no waitUntil,
      // so handleCloudfrontRequest awaits the background work before returning (bounded —
      // and aborted at the deadline — only if backgroundWorkTimeoutMs is set).
      const instance = new SupertabConnect({
        apiKey: options.apiKey,
        botDetector: options.botDetector,
        enforcement: options.enforcement,
        analyticsEnabled: options.analyticsEnabled,
        analyticsBaseUrl: options.analyticsBaseUrl,
        debug: options.debug,
      });
      if (options.debug) {
        console.log(
          `[SupertabConnect] analytics: ${instance.analyticsEnabled ? "enabled (http)" : "disabled (noop)"}`
        );
      }
      return await handleCloudfrontRequest(instance, event, options.backgroundWorkTimeoutMs, options.debug);
    } catch (err) {
      console.error("[SupertabConnect] cloudfrontHandleRequests failed:", err);
      return request;
    }
  }
}
