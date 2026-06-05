import {
  HandlerAction,
  HandlerResult,
  ExecutionContext,
  CDNStatusDescription,
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "./types";
import { hostRSLicenseXML } from "./license";

/** Parse a CDN ASN header (e.g. "13335" or "AS13335") to a positive integer, or null. */
export function parseAsn(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.trim().replace(/^as/i, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface HandleRequestContext {
  ctx?: ExecutionContext;
  sourceCdn: "cloudflare" | "fastly" | "cloudfront";
  clientIp?: string;
  requestId?: string;
  requestCountry?: string | null;
  requestAsn?: number | null;
  tlsFingerprint?: string | null;
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
  const result = await handler.handleRequest(request, {
    ctx,
    sourceCdn: "cloudflare",
    requestId: request.headers.get("cf-ray") ?? undefined,
    clientIp: request.headers.get("cf-connecting-ip") ?? undefined,
    requestCountry: request.headers.get("cf-ipcountry") ?? cf?.country ?? null,
    requestAsn: typeof cf?.asn === "number" ? cf.asn : null,
    tlsFingerprint: cf?.botManagement?.ja3Hash ?? null,
  });

  switch (result.action) {
    case HandlerAction.BLOCK:
      return new Response(result.body, {
        status: result.status,
        headers: new Headers(result.headers),
      });
    case HandlerAction.ALLOW: {
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
      const originResponse = await fetch(fetchTarget);
      return applyResponseHeaders(originResponse, result.headers);
    }
  }
}

/**
 * Handles an Origin request in Fastly. Expects `X-Original-Request-URL` header to contain the original viewer request URL.
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
  }
): Promise<Response> {
  const originalUrl = request.headers.get("x-original-request-url") || request.url;

  if (rslOptions && new URL(originalUrl).pathname === "/license.xml") {
    return await hostRSLicenseXML(
      rslOptions.baseUrl,
      rslOptions.merchantSystemUrn
    );
  }

  const asnHeader = request.headers.get("fastly-client-asn");
  const webRequest = new Request(originalUrl, {
    method: request.method,
    headers: request.headers,
  });

  const result = await handler.handleRequest(webRequest, {
    sourceCdn: "fastly",
    clientIp: request.headers.get("fastly-client-ip") ?? undefined,
    requestCountry: request.headers.get("fastly-client-country-code") ?? null,
    requestAsn: parseAsn(asnHeader),
    tlsFingerprint: request.headers.get("fastly-client-ja3") ?? null,
  });

  switch (result.action) {
    case HandlerAction.BLOCK:
      return new Response(result.body, {
        status: result.status,
        headers: new Headers(result.headers),
      });
    case HandlerAction.ALLOW: {
      const originResponse = await fetch(request, { backend: originBackend } as RequestInit);
      return applyResponseHeaders(originResponse, result.headers);
    }
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
 * Handles an Origin request in CloudFront. Expects X-Original-Request-URL header to contain the original viewer request URL.
 * @param handler
 * @param event
 */
export async function handleCloudfrontRequest<TRequest extends Record<string, any>>(
  handler: RequestHandler,
  event: CloudFrontRequestEvent<TRequest>
): Promise<CloudFrontRequestResult<TRequest>> {
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

  const asnHeader = headers.get("cloudfront-viewer-asn");
  const result = await handler.handleRequest(webRequest, {
    sourceCdn: "cloudfront",
    requestId: config?.requestId ?? undefined,
    clientIp: cfRequest.clientIp,
    requestCountry: headers.get("cloudfront-viewer-country") ?? null,
    requestAsn: parseAsn(asnHeader),
    tlsFingerprint: headers.get("cloudfront-viewer-ja3-fingerprint") ?? null,
  });

  if (result.action === HandlerAction.BLOCK) {
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
