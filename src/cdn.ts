import { SupertabConnect } from "./index";
import { BotDetector, EnforcementMode, Env, HandlerAction } from "./types";
import { hostRSLicenseXML } from "./license";

export async function cloudflareHandleRequests(
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

  const result = await supertabConnect.handleRequest(request, ctx);

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

export async function fastlyHandleRequests(
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
  const { enableRSL = false, botDetector, enforcement } = options ?? {};

  // Prepare or get the SupertabConnect instance
  const supertabConnect = new SupertabConnect({
    apiKey: merchantApiKey,
    merchantSystemUrn: merchantSystemUrn,
    botDetector,
    enforcement,
  });

  if (enableRSL) {
    if (new URL(request.url).pathname === "/license.xml") {
      return await hostRSLicenseXML(
        SupertabConnect.getBaseUrl(),
        merchantSystemUrn
      );
    }
  }

  const result = await supertabConnect.handleRequest(request);

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
