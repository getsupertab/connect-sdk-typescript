import {
  HandlerAction,
  HandlerResult,
  ExecutionContext,
  CDNStatusDescription,
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "./types";
import { CdnRequestSignals, ClientIpSource, StatusSource } from "./analytics/types";
import { hostRSLicenseXML } from "./license";
import { resolveFastlyRequestUrl } from "./fastly-url";

/**
 * Default budget (ms) for the pre-response background-work wait on CloudFront, applied when
 * `backgroundWorkTimeoutMs` is not set. Lambda@Edge has no `waitUntil`, so background work
 * has to be awaited before the response returns; 2s leaves headroom under the viewer-request
 * trigger's 5s ceiling, past which CloudFront returns a 502 to the viewer.
 */
export const DEFAULT_BACKGROUND_WORK_TIMEOUT_MS = 2000;

/** Parse a CDN ASN header (e.g. "13335" or "AS13335") to a positive integer, or null. */
export function parseAsn(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim().replace(/^as/i, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Coerce a request.cf value to a non-empty string, or null. */
function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** Coerce a request.cf value (possibly a numeric string) to an integer, or null. */
function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map Cloudflare's `request.cf` plumbing onto the Capture-v2 signal contract.
 * Fail-open: pure field reads, never throws. Free-plan fields populate; the
 * Enterprise-only JA4 stays null until a zone upgrades (defined now so the data
 * flows the day it does — it is unbackfillable). `tlsClientHelloLength` arrives
 * as a string and is parsed to an int.
 * @param cf The Worker request's `cf` object.
 * @returns The Capture-v2 signal set, with unexposed fields null.
 */
export function extractCloudflareCdnSignals(cf: Record<string, any>): CdnRequestSignals {
  return {
    accept_encoding: toStringOrNull(cf.clientAcceptEncoding),
    http_protocol: toStringOrNull(cf.httpProtocol),
    tls_version: toStringOrNull(cf.tlsVersion),
    tls_cipher: toStringOrNull(cf.tlsCipher),
    tls_client_hello_length: toIntOrNull(cf.tlsClientHelloLength),
    tls_client_extensions_sha1: toStringOrNull(cf.tlsClientExtensionsSha1),
    as_organization: toStringOrNull(cf.asOrganization),
    client_tcp_rtt: toIntOrNull(cf.clientTcpRtt),
    cdn_verified_bot_category: toStringOrNull(cf.verifiedBotCategory),
    request_priority: toStringOrNull(cf.requestPriority),
    tls_fingerprint_ja4: toStringOrNull(cf.botManagement?.ja4),
  };
}

/**
 * Map CloudFront's `cloudfront-viewer-*` request headers onto the Capture-v2 signal
 * contract. Fail-open: pure header reads, never throws. Fields CloudFront does not expose
 * as viewer headers stay null. The `cloudfront-viewer-tls` header packs version and cipher
 * as `<version>:<cipher>:<handshake>` (e.g. `TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake`).
 * @param headers The request headers, as forwarded to the Lambda@Edge trigger.
 * @returns The Capture-v2 signal set, with unexposed fields null.
 */
export function extractCloudfrontCdnSignals(headers: Headers): CdnRequestSignals {
  const tls = headers.get("cloudfront-viewer-tls");
  let tlsVersion: string | null = null;
  let tlsCipher: string | null = null;
  if (tls) {
    const [version, cipher] = tls.split(":");
    tlsVersion = version || null;
    tlsCipher = cipher || null;
  }
  return {
    accept_encoding: headers.get("accept-encoding"),
    http_protocol: headers.get("cloudfront-viewer-http-version"),
    tls_version: tlsVersion,
    tls_cipher: tlsCipher,
    tls_client_hello_length: null,
    tls_client_extensions_sha1: null,
    as_organization: headers.get("cloudfront-viewer-as-name"),
    client_tcp_rtt: null,
    cdn_verified_bot_category: null,
    request_priority: null,
    tls_fingerprint_ja4: headers.get("cloudfront-viewer-ja4-fingerprint"),
  };
}

export interface HandleRequestContext {
  ctx?: ExecutionContext;
  // Omitted when the request did not pass through a CDN (e.g. invoked directly via the SDK).
  sourceCdn?: "cloudflare" | "fastly" | "cloudfront";
  clientIp?: string;
  // Provenance of clientIp. Only whoever resolved the address can assert this, so a caller
  // supplying its own clientIp and omitting this leaves the column NULL rather than having
  // the SDK guess on its behalf.
  clientIpSource?: ClientIpSource;
  // Hold the analytics event back until the caller reports the response, so it can carry a
  // real status_code. A request, not a command: the SDK honours it only when `ctx` is present
  // to keep the runtime alive for the emit, and otherwise sends eagerly. Only ALLOW is ever
  // held — a blocked request already knows its own status — so `reportResponse` is attached
  // only there, and opting in means you MUST call it from a `finally` or that event is lost.
  deferAnalytics?: boolean;
  requestId?: string;
  requestCountry?: string | null;
  requestAsn?: number | null;
  tlsFingerprint?: string | null;
  // Capture-v2 CDN plumbing not derivable from the portable Request.
  cdnSignals?: CdnRequestSignals;
}

// Interface for what the CDN handlers need - avoids circular dependency
interface RequestHandler {
  handleRequest(request: Request, context?: HandleRequestContext): Promise<HandlerResult>;
}

function applyResponseHeaders(response: Response, headers?: Record<string, string>): Response {
  if (!headers) return response;
  const merged = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    merged.headers.set(key, value);
  }
  return merged;
}

export async function handleCloudflareRequest(
  handler: RequestHandler,
  request: Request,
  ctx: ExecutionContext,
  originUrl?: string
): Promise<Response> {
  const cf = (request as unknown as { cf?: Record<string, any> }).cf;
  // Read once and branch on truthiness for both: `.has()` would report `cdn_declared` for a
  // present-but-empty header, whose address normalizes to the "::" sentinel.
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  const result = await handler.handleRequest(request, {
    ctx,
    deferAnalytics: true,
    sourceCdn: "cloudflare",
    requestId: request.headers.get("cf-ray") ?? undefined,
    // cf-connecting-ip is Cloudflare's own view of who connected to it; absent leaves
    // clientIp undefined, which normalizes to the "::" sentinel.
    clientIp: cfConnectingIp || undefined,
    clientIpSource: cfConnectingIp ? "cdn_declared" : "absent",
    requestCountry: request.headers.get("cf-ipcountry") ?? cf?.country ?? null,
    requestAsn: typeof cf?.asn === "number" ? cf.asn : null,
    tlsFingerprint: cf?.botManagement?.ja3Hash ?? null,
    cdnSignals: cf ? extractCloudflareCdnSignals(cf) : undefined,
  });

  // BLOCK / RESPOND already carried their own status out of handleRequest, which attaches the
  // reporter only for ALLOW. Returned before the try so nothing reports a null status for a
  // response whose status was never in doubt.
  if (result.action !== HandlerAction.ALLOW) {
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }

  // Reported in a finally so a thrown origin fetch still sends the event: losing the status
  // is acceptable, losing the whole row is not. `status` arrives with the response headers,
  // so reading it costs nothing and never waits on a body.
  let status: number | null = null;
  let source: StatusSource | undefined;
  try {
    // When `originUrl` is provided, forward to that host while preserving
    // path / query / method / headers / body. Decouples validation URL
    // (request.url, used for token audience checks) from fetch destination.
    // Production Cloudflare deployments can omit this — Workers Routes put
    // the Worker on the publisher's hostname, so `fetch(request)` already
    // resolves to the origin via the edge.
    const fetchTarget = originUrl
      ? new Request(
          `${new URL(originUrl).origin}${new URL(request.url).pathname}${new URL(request.url).search}`,
          request
        )
      : request;
    // Set before the await and cleared after, so a throw leaves "origin_error" standing.
    source = "origin_error";
    let originResponse: Response;
    try {
      originResponse = await fetch(fetchTarget);
    } catch {
      // Fail open here rather than leaving it to cloudflareHandleRequests, so the status
      // reported is the one the client actually receives. Reporting from a boundary the
      // retry sits outside of would record "origin_error" for a request the retry served.
      originResponse = await fetch(request);
    }
    status = originResponse.status;
    source = undefined;
    return applyResponseHeaders(originResponse, result.headers);
  } finally {
    result.reportResponse?.(status, source);
  }
}

/** Per-service Fastly settings that are not request data. */
export interface FastlyRequestOptions {
  /** Header carrying the viewer authority; defaults to `DEFAULT_ORIGINAL_AUTHORITY_HEADER`. */
  originalAuthorityHeader?: string;
}

/**
 * Handles a request in Fastly Compute. The viewer's URL is recovered by
 * `resolveFastlyRequestUrl`: on a VCL → Compute chain the inbound `Host` is the Compute
 * service's own domain, so the authority comes from the preserved-authority header (or the
 * older full-URL `X-Original-Request-URL`) instead.
 * @param handler Request handler instance that inspects the request and decides whether to allow or block it.
 * @param request Fastly request to process.
 * @param originBackend Fastly backend name used when forwarding allowed requests to origin.
 * @param rslOptions Optional configuration for serving `/license.xml` directly from the edge.
 * @param rslOptions.baseUrl Base URL used when generating the hosted license XML response.
 * @param rslOptions.merchantSystemUrn Merchant system URN for fetching the license from Supertab Connect.
 */
export async function handleFastlyRequest(
  handler: RequestHandler,
  request: Request,
  originBackend: string,
  rslOptions?: {
    baseUrl: string;
    merchantSystemUrn: string;
  },
  // On Fastly Compute, client IP, geo, and JA3 are on the FetchEvent, not request
  // headers. The caller (fastlyHandleRequests) passes them through from event.client.
  clientContext?: {
    clientIp?: string;
    clientIpSource?: ClientIpSource;
    requestCountry?: string | null;
    requestAsn?: number | null;
    tlsFingerprint?: string | null;
  },
  // Wraps FetchEvent.waitUntil so post-response analytics emits stay alive until
  // they settle — the BLOCK path returns immediately, with no origin fetch to
  // incidentally keep the instance up.
  ctx?: ExecutionContext,
  // One trailing object rather than a seventh positional: per-service Fastly knobs arrive a
  // release at a time, and every existing call site keeps compiling as they do.
  options?: FastlyRequestOptions
): Promise<Response> {
  const { url: viewerUrl } = resolveFastlyRequestUrl(request, options?.originalAuthorityHeader);

  if (rslOptions && viewerUrl.pathname === "/license.xml") {
    return await hostRSLicenseXML(
      rslOptions.baseUrl,
      rslOptions.merchantSystemUrn
    );
  }

  const asnHeader = request.headers.get("fastly-client-asn");

  // The address and its provenance must come from the SAME branch. Selecting them with two
  // independent expressions lets a caller-supplied address be labelled by a header it did not
  // come from — reporting `cdn_declared` for an address the CDN never vouched for.
  const contextClientIp = clientContext?.clientIp;
  const headerClientIp = request.headers.get("fastly-client-ip");
  const resolvedClientIp = contextClientIp || headerClientIp || undefined;
  const resolvedClientIpSource: ClientIpSource | undefined = contextClientIp
    ? // Only the caller knows where its own address came from; undefined stays NULL rather
      // than being inferred from a header that did not supply it.
      clientContext?.clientIpSource
    : headerClientIp
      ? "cdn_declared"
      : "absent";

  // The copied `Host` header stays as Fastly delivered it — the hop's, on a chain — and so
  // deliberately disagrees with this URL: `Host` is a forbidden header, so rewriting it is a
  // silent no-op in some runtimes and throws in others. Nothing downstream needs it to agree;
  // the origin forward below uses the ORIGINAL `request`, never this one.
  const webRequest = new Request(viewerUrl.href, {
    method: request.method,
    headers: request.headers,
  });

  const result = await handler.handleRequest(webRequest, {
    ctx,
    deferAnalytics: true,
    sourceCdn: "fastly",
    // Prefer caller-supplied values (Compute: event.client.*) over header fallbacks (VCL only).
    clientIp: resolvedClientIp,
    clientIpSource: resolvedClientIpSource,
    requestCountry: clientContext?.requestCountry !== undefined ? clientContext.requestCountry : (request.headers.get("fastly-client-country-code") ?? null),
    requestAsn: clientContext?.requestAsn !== undefined ? clientContext.requestAsn : parseAsn(asnHeader),
    // JA3 comes from event.client.tlsJA3MD5 on Compute; the header is VCL-only.
    tlsFingerprint: clientContext?.tlsFingerprint !== undefined ? clientContext.tlsFingerprint : (request.headers.get("fastly-client-ja3") ?? null),
    cdnSignals: {
      accept_encoding: request.headers.get("accept-encoding"),
      // No event field for JA4 in the Compute runtime — header (VCL) only.
      tls_fingerprint_ja4: request.headers.get("fastly-client-ja4"),
    },
  });

  // See handleCloudflareRequest for both: non-ALLOW returns before the try, and the origin
  // status is reported in a finally so a failed fetch costs the status, not the event.
  if (result.action !== HandlerAction.ALLOW) {
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }

  let status: number | null = null;
  let source: StatusSource | undefined;
  try {
    // Set before the await and cleared after, so a throw leaves "origin_error" standing.
    source = "origin_error";
    let originResponse: Response;
    try {
      originResponse = await fetch(request, { backend: originBackend } as RequestInit);
    } catch {
      // See handleCloudflareRequest: fail open here so the reported status is the one the
      // client receives, rather than letting fastlyHandleRequests retry outside the reporter.
      originResponse = await fetch(request, { backend: originBackend } as RequestInit);
    }
    status = originResponse.status;
    source = undefined;
    return applyResponseHeaders(originResponse, result.headers);
  } finally {
    result.reportResponse?.(status, source);
  }
}

function statusDescription(status: number): CDNStatusDescription {
  switch (status) {
    case 401: return CDNStatusDescription.Unauthorized;
    case 402: return CDNStatusDescription.PaymentRequired;
    case 403: return CDNStatusDescription.Forbidden;
    case 503: return CDNStatusDescription.ServiceUnavailable;
    default: return CDNStatusDescription.Error;
  }
}

/**
 * Handles a CloudFront request event (viewer-request or origin-request). At origin-request
 * the X-Original-Request-URL header carries the original viewer URL (the host header is the
 * origin's); at viewer-request the header is absent and the host header IS the viewer host,
 * so the fallback reconstruction below is already correct.
 * @param handler Request handler used to make the licensing decision for the event.
 * @param event The CloudFront request event (viewer-request or origin-request).
 * @param backgroundWorkTimeoutMs Absolute budget (ms), measured from entry to this function,
 *   on the pre-response wait for background work (analytics emit + legacy event recording).
 *   In-flight calls are aborted at the deadline. Defaults to
 *   `DEFAULT_BACKGROUND_WORK_TIMEOUT_MS`; pass `Infinity` to await to completion instead.
 *   Non-finite or non-positive values fall back to the default with a warning.
 * @param debug Enable debug logging of the background-work drain (default: false).
 * @returns The pass-through request, or a CloudFront response when the handler blocks/responds.
 */
export async function handleCloudfrontRequest<TRequest extends Record<string, any>>(
  handler: RequestHandler,
  event: CloudFrontRequestEvent<TRequest>,
  backgroundWorkTimeoutMs?: number,
  debug: boolean = false
): Promise<CloudFrontRequestResult<TRequest>> {
  // `undefined` means "caller expressed no preference" — take the default rather than
  // waiting forever, since an unbounded wait can walk a viewer-request Lambda into its 5s
  // ceiling (CloudFront turns that into a 502). `Infinity` is the explicit opt-out.
  let budgetMs: number | undefined;
  if (backgroundWorkTimeoutMs === undefined) {
    budgetMs = DEFAULT_BACKGROUND_WORK_TIMEOUT_MS;
  } else if (backgroundWorkTimeoutMs === Infinity) {
    budgetMs = undefined;
  } else if (!Number.isFinite(backgroundWorkTimeoutMs) || backgroundWorkTimeoutMs <= 0) {
    console.warn(
      `[SupertabConnect] ignoring invalid backgroundWorkTimeoutMs: ${backgroundWorkTimeoutMs} (falling back to the ${DEFAULT_BACKGROUND_WORK_TIMEOUT_MS}ms default)`
    );
    budgetMs = DEFAULT_BACKGROUND_WORK_TIMEOUT_MS;
  } else {
    budgetMs = backgroundWorkTimeoutMs;
  }

  const cfRequest = event.Records[0].cf.request;
  const config = event.Records[0].cf.config;

  // Convert CloudFront request to Web API Request
  const viewerRequestUrl = cfRequest.headers?.["x-original-request-url"]?.[0]?.value;
  const originRequestUrl = `${cfRequest.headers.host[0].value}${cfRequest.uri}`;
  const url = `https://${viewerRequestUrl ? viewerRequestUrl : originRequestUrl}${cfRequest.querystring ? "?" + cfRequest.querystring : ""}`;

  const headers = new Headers();
  Object.entries(cfRequest.headers).forEach(([key, values]) => {
    values.forEach(({ value }) => headers.append(key, value));
  });

  const webRequest = new Request(url, {
    method: cfRequest.method,
    headers: headers,
  });

  // Lambda@Edge has no `waitUntil` — collect the analytics emit and legacy /events promises
  // here and await them before returning, since a detached fetch is frozen when the handler
  // resolves and would be dropped.
  //
  // backgroundWorkTimeoutMs is an absolute budget measured from HERE (so time spent in
  // verification/JWKS counts against it, not just the drain). At the deadline the signal
  // aborts the in-flight background fetches — merely abandoning them would leave work that
  // can resume inside a later invocation of a reused environment.
  const pending: Promise<void>[] = [];
  const startedAt = Date.now();
  let timedOut = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const deadline = new Promise<void>((resolve) => {
    if (budgetMs === undefined) return; // never resolves — explicitly unbounded
    controller = new AbortController();
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller!.abort();
      resolve();
    }, budgetMs);
  });
  const ctx: ExecutionContext = {
    waitUntil: (promise) => { pending.push(promise); },
    signal: controller?.signal,
  };

  // These headers only exist at origin-request (CloudFront adds them after the viewer-request
  // event, per origin request policy) — at viewer-request they degrade to null.
  const asnHeader = headers.get("cloudfront-viewer-asn");
  const result = await handler.handleRequest(webRequest, {
    ctx,
    sourceCdn: "cloudfront",
    requestId: config?.requestId ?? undefined,
    // Lambda@Edge exposes the viewer address as an event field rather than a header, but
    // it means the same thing as cf-connecting-ip: CloudFront's view of who reached it.
    clientIp: cfRequest.clientIp,
    clientIpSource: cfRequest.clientIp ? "cdn_declared" : "absent",
    requestCountry: headers.get("cloudfront-viewer-country") ?? null,
    requestAsn: parseAsn(asnHeader),
    tlsFingerprint: headers.get("cloudfront-viewer-ja3-fingerprint") ?? null,
    cdnSignals: extractCloudfrontCdnSignals(headers),
  });

  // Drain the pending calls before returning. The promises swallow their own errors, so
  // allSettled never rejects. By default the drain is unbounded (correctness over latency);
  // with a budget, the deadline both aborts the in-flight calls (real cancellation) and
  // wins the race (hard return-time backstop for anything that ignores the signal).
  if (pending.length) {
    await Promise.race([Promise.allSettled(pending), deadline]);
    if (debug) {
      const elapsedMs = Date.now() - startedAt;
      console.log(
        timedOut
          ? `[SupertabConnect] cloudfront background work: timed out after ${elapsedMs}ms (budget ${budgetMs}ms) — in-flight calls aborted`
          : `[SupertabConnect] cloudfront background work: ${pending.length} calls settled in ${elapsedMs}ms` +
            (budgetMs !== undefined ? ` (budget ${budgetMs}ms)` : " (unbounded)")
      );
    }
  }
  clearTimeout(deadlineTimer);

  if (result.action === HandlerAction.BLOCK || result.action === HandlerAction.RESPOND) {
    const responseHeaders: CloudFrontHeaders = {};
    Object.entries(result.headers).forEach(([key, value]) => {
      responseHeaders[key.toLowerCase()] = [{ key, value }];
    });

    return {
      status: result.status.toString(),
      statusDescription: statusDescription(result.status),
      headers: responseHeaders,
      body: result.body,
    };
  }

  // Allow request to continue to origin
  return cfRequest;
}
