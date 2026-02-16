import {
  HandlerAction,
  HandlerResult,
  ExecutionContext,
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "./types";
import { hostRSLicenseXML } from "./license";

// Interface for what the CDN handlers need - avoids circular dependency
interface RequestHandler {
  handleRequest(request: Request, ctx?: ExecutionContext): Promise<HandlerResult>;
}

export async function handleCloudflareRequest(
  handler: RequestHandler,
  request: Request,
  ctx: ExecutionContext
): Promise<Response> {
  const result = await handler.handleRequest(request, ctx);

  if (result.action === HandlerAction.BLOCK) {
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }

  // action === HandlerAction.ALLOW
  const originResponse = await fetch(request);

  if (result.headers) {
    const response = new Response(originResponse.body, originResponse);
    for (const [key, value] of Object.entries(result.headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  return originResponse;
}

export async function handleFastlyRequest(
  handler: RequestHandler,
  request: Request,
  originBackend: string,
  rslOptions?: {
    baseUrl: string;
    merchantSystemUrn: string;
  }
): Promise<Response> {
  if (rslOptions && new URL(request.url).pathname === "/license.xml") {
    return await hostRSLicenseXML(
      rslOptions.baseUrl,
      rslOptions.merchantSystemUrn
    );
  }

  const result = await handler.handleRequest(request);

  if (result.action === HandlerAction.BLOCK) {
    return new Response(result.body, {
      status: result.status,
      headers: new Headers(result.headers),
    });
  }

  // action === HandlerAction.ALLOW
  const originResponse = await fetch(request, {
    backend: originBackend,
  } as RequestInit);

  if (result.headers) {
    const response = new Response(originResponse.body, originResponse);
    for (const [key, value] of Object.entries(result.headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  return originResponse;
}

function statusDescription(status: number): string {
  switch (status) {
    case 401: return "Unauthorized";
    case 402: return "Payment Required";
    case 403: return "Forbidden";
    case 503: return "Service Unavailable";
    default: return "Error";
  }
}

export async function handleCloudfrontRequest<TRequest extends Record<string, any>>(
  handler: RequestHandler,
  event: CloudFrontRequestEvent<TRequest>
): Promise<CloudFrontRequestResult<TRequest>> {
  const cfRequest = event.Records[0].cf.request;

  // Convert CloudFront request to Web API Request
  const url = `https://${cfRequest.headers.host[0].value}${cfRequest.uri}${cfRequest.querystring ? "?" + cfRequest.querystring : ""}`;

  const headers = new Headers();
  Object.entries(cfRequest.headers).forEach(([key, values]) => {
    values.forEach(({ value }) => headers.append(key, value));
  });

  const webRequest = new Request(url, {
    method: cfRequest.method,
    headers: headers,
  });

  const result = await handler.handleRequest(webRequest);

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
