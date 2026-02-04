import type { JWTPayload, JWTHeaderParameters } from "jose";
import { loadJose } from "./jose";

interface LicenseJWTPayload extends JWTPayload {
  license_id?: string;
}
import {
  HandlerAction,
  HandlerResult,
  LicenseTokenInvalidReason,
  LicenseTokenVerificationResult,
  FASTLY_BACKEND,
  FetchOptions,
} from "./types";
import { fetchPlatformJwks } from "./jwks";

export type EventRecorder = (
  eventName: string,
  properties: Record<string, any>,
  licenseId?: string
) => Promise<void>;

const stripTrailingSlash = (value: string) => value.trim().replace(/\/+$/, "");

export type VerifyLicenseTokenParams = {
  licenseToken: string;
  requestUrl: string;
  supertabBaseUrl: string;
  debug: boolean;
};

export async function verifyLicenseToken({
  licenseToken,
  requestUrl,
  supertabBaseUrl,
  debug,
}: VerifyLicenseTokenParams): Promise<LicenseTokenVerificationResult> {
  const { decodeProtectedHeader, decodeJwt, jwtVerify } = await loadJose();
  if (!licenseToken) {
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.MISSING_TOKEN,
    };
  }

  let header: JWTHeaderParameters;
  try {
    header = decodeProtectedHeader(licenseToken) as JWTHeaderParameters;
  } catch (error) {
    if (debug) {
      console.error("Invalid license JWT header:", error);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_HEADER,
    };
  }

  if (header.alg !== "ES256") {
    if (debug) {
      console.error("Unsupported license JWT alg:", header.alg);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_ALG,
    };
  }

  let payload: LicenseJWTPayload;
  try {
    payload = decodeJwt(licenseToken) as LicenseJWTPayload;
  } catch (error) {
    if (debug) {
      console.error("Invalid license JWT payload:", error);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_PAYLOAD,
    };
  }

  const licenseId: string | undefined = payload.license_id;

  const issuer: string | undefined = payload.iss;
  const normalizedIssuer = issuer ? stripTrailingSlash(issuer) : undefined;
  const normalizedBaseUrl = stripTrailingSlash(supertabBaseUrl);

  if (!normalizedIssuer || !normalizedIssuer.startsWith(normalizedBaseUrl)) {
    if (debug) {
      console.error("License JWT issuer is missing or malformed:", issuer);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_ISSUER,
      licenseId,
    };
  }

  const audienceValues = Array.isArray(payload.aud)
    ? payload.aud.filter((entry): entry is string => typeof entry === "string")
    : typeof payload.aud === "string"
    ? [payload.aud]
    : [];

  const requestUrlNormalized = stripTrailingSlash(requestUrl);
  const matchesRequestUrl = audienceValues.some((value) => {
    const normalizedAudience = stripTrailingSlash(value);
    if (!normalizedAudience) return false;
    return requestUrlNormalized.startsWith(normalizedAudience);
  });

  if (!matchesRequestUrl) {
    if (debug) {
      console.error(
        "License JWT audience does not match request URL:",
        payload.aud
      );
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_AUDIENCE,
      licenseId,
    };
  }

  let jwks;
  try {
    jwks = await fetchPlatformJwks(supertabBaseUrl, debug);
  } catch (error) {
    if (debug) {
      console.error("Failed to fetch platform JWKS:", error);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.SERVER_ERROR,
      licenseId,
    };
  }

  try {
    const getKey = async (jwtHeader: JWTHeaderParameters) => {
      const jwk = jwks.keys.find((key: any) => key.kid === jwtHeader.kid);
      if (!jwk) {
        throw new Error(`No matching platform key found: ${jwtHeader.kid}`);
      }
      return jwk;
    };

    const result = await jwtVerify(licenseToken, getKey, {
      issuer,
      algorithms: [header.alg],
      clockTolerance: "1m",
    });

    return {
      valid: true,
      licenseId,
      payload: result.payload,
    };
  } catch (error) {
    if (debug) {
      console.error("License JWT verification failed:", error);
    }

    if (error instanceof Error && error.message?.includes("exp")) {
      return {
        valid: false,
        reason: LicenseTokenInvalidReason.EXPIRED,
        licenseId,
      };
    }

    return {
      valid: false,
      reason: LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED,
      licenseId,
    };
  }
}

export function generateLicenseLink({
  requestUrl,
}: {
  requestUrl: string;
}): string {
  const baseURL = new URL(requestUrl);
  return `${baseURL.protocol}//${baseURL.host}/license.xml`;
}

/**
 * Build a HandlerResult that signals a missing token in soft enforcement mode.
 * Returns headers indicating a license is required without blocking the request.
 */
export function buildSignalResult(requestUrl: string): HandlerResult {
  const licenseLink = generateLicenseLink({ requestUrl });
  return {
    action: HandlerAction.ALLOW,
    headers: {
      Link: `<${licenseLink}>; rel="license"; type="application/rsl+xml"`,
      "X-RSL-Status": "token_required",
      "X-RSL-Reason": "missing",
    },
  };
}

export function buildBlockResult({
  reason,
  requestUrl,
  supertabBaseUrl,
}: {
  reason: LicenseTokenInvalidReason | string;
  requestUrl: string;
  supertabBaseUrl: string;
}): HandlerResult {
  let rslError: string;
  let errorDescription: string;
  let status: number;

  switch (reason) {
    // 401 — invalid_request: missing or malformed request
    case LicenseTokenInvalidReason.MISSING_TOKEN:
      status = 401;
      rslError = "invalid_request";
      errorDescription = "Authorization header missing or malformed";
      break;
    case LicenseTokenInvalidReason.INVALID_ALG:
      status = 401;
      rslError = "invalid_request";
      errorDescription = "Unsupported token algorithm";
      break;

    // 401 — invalid_token: token exists but is bad
    case LicenseTokenInvalidReason.EXPIRED:
      status = 401;
      rslError = "invalid_token";
      errorDescription = "The license token has expired";
      break;
    case LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED:
      status = 401;
      rslError = "invalid_token";
      errorDescription = "The license token signature is invalid";
      break;
    case LicenseTokenInvalidReason.INVALID_HEADER:
      status = 401;
      rslError = "invalid_token";
      errorDescription = "The license token header is malformed";
      break;
    case LicenseTokenInvalidReason.INVALID_PAYLOAD:
      status = 401;
      rslError = "invalid_token";
      errorDescription = "The license token payload is malformed";
      break;
    case LicenseTokenInvalidReason.INVALID_ISSUER:
      status = 401;
      rslError = "invalid_token";
      errorDescription = "The license token issuer is not recognized";
      break;
    // 403 — insufficient_scope: valid token, wrong resource/usage
    case LicenseTokenInvalidReason.INVALID_AUDIENCE:
      status = 403;
      rslError = "insufficient_scope";
      errorDescription = "The license does not grant access to this resource";
      break;
    // 503 — server-side validation failure
    case LicenseTokenInvalidReason.SERVER_ERROR:
      status = 503;
      rslError = "server_error";
      errorDescription = "The server encountered an error validating the license";
      break;

    default:
      status = 401;
      rslError = "invalid_token";
      errorDescription = "License token missing, expired, revoked, or malformed";
  }

  const licenseLink = generateLicenseLink({ requestUrl });

  return {
    action: HandlerAction.BLOCK,
    status,
    body: `Access to this resource requires a valid license token. Error: ${rslError} - ${errorDescription}`,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "WWW-Authenticate": `License error="${rslError}", error_description="${errorDescription}"`,
      Link: `<${licenseLink}>; rel="license"; type="application/rsl+xml"`,
    },
  };
}

function buildFetchOptions(): FetchOptions {
  let options: FetchOptions = { method: "GET" };
  // @ts-ignore - backend is a Fastly-specific extension
  if (globalThis?.fastly) {
    options = { ...options, backend: FASTLY_BACKEND };
  }
  return options;
}

export async function hostRSLicenseXML(
  supertabBaseUrl: string,
  merchantSystemUrn: string
): Promise<Response> {
  const licenseUrl = `${supertabBaseUrl}/merchants/systems/${merchantSystemUrn}/license.xml`;
  const response = await fetch(licenseUrl, buildFetchOptions());

  if (!response.ok) {
    return new Response("License not found", { status: 404 });
  }

  const licenseXml = await response.text();

  return new Response(licenseXml, {
    status: 200,
    headers: new Headers({ "Content-Type": "application/xml" }),
  });
}

export type ValidateTokenParams = {
  token: string;
  url: string;
  userAgent: string;
  supertabBaseUrl: string;
  debug: boolean;
  recordEvent?: EventRecorder;
  ctx?: any;
};

export async function validateTokenAndBuildResult(
  params: ValidateTokenParams
): Promise<HandlerResult> {
  const verification = await verifyLicenseToken({
    licenseToken: params.token,
    requestUrl: params.url,
    supertabBaseUrl: params.supertabBaseUrl,
    debug: params.debug,
  });

  if (params.recordEvent) {
    const eventName = verification.valid
      ? "license_used"
      : verification.reason || "license_token_verification_failed";

    const eventProperties = {
      page_url: params.url,
      user_agent: params.userAgent,
      verification_status: verification.valid ? "valid" : "invalid",
      verification_reason: verification.reason || "success",
    };

    const eventPromise = params.recordEvent(
      eventName,
      eventProperties,
      verification.licenseId
    );

    if (params.ctx?.waitUntil) {
      params.ctx.waitUntil(eventPromise);
    }
  }

  if (!verification.valid) {
    return buildBlockResult({
      reason: verification.reason || LicenseTokenInvalidReason.MISSING_TOKEN,
      requestUrl: params.url,
      supertabBaseUrl: params.supertabBaseUrl,
    });
  }

  return { action: HandlerAction.ALLOW };
}
