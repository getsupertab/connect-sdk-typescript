import { HandlerAction, HandlerResult } from "./types";
import { hostRSLicenseXML } from "./license";

// Interface for what the CDN handlers need - avoids circular dependency
interface RequestHandler {
  handleRequest(request: Request, ctx?: any): Promise<HandlerResult>;
}

export async function handleCloudflareRequest(
  handler: RequestHandler,
  request: Request,
  ctx: any
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
