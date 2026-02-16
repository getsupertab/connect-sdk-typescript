import type { JWTPayload, JWTHeaderParameters } from "jose";
import { loadJwtVerify, loadDecodeJwt, loadDecodeProtectedHeader } from "./jose";

interface LicenseJWTPayload extends JWTPayload {
  license_id?: string;
}
import {
  ExecutionContext,
  HandlerAction,
  HandlerResult,
  LicenseTokenInvalidReason,
  LicenseTokenVerificationResult,
  FASTLY_BACKEND,
  FetchOptions,
} from "./types";
import { fetchPlatformJwks, clearJwksCache, JwksKeyNotFoundError } from "./jwks";
import { recordEvent } from "./events";

const stripTrailingSlash = (value: string) => value.trim().replace(/\/+$/, "");

function reasonToErrorDescription(reason: LicenseTokenInvalidReason): string {
  switch (reason) {
    case LicenseTokenInvalidReason.MISSING_TOKEN:
      return "Authorization header missing or malformed";
    case LicenseTokenInvalidReason.INVALID_ALG:
      return "Unsupported token algorithm";
    case LicenseTokenInvalidReason.EXPIRED:
      return "The license token has expired";
    case LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED:
      return "The license token signature is invalid";
    case LicenseTokenInvalidReason.INVALID_HEADER:
      return "The license token header is malformed";
    case LicenseTokenInvalidReason.INVALID_PAYLOAD:
      return "The license token payload is malformed";
    case LicenseTokenInvalidReason.INVALID_ISSUER:
      return "The license token issuer is not recognized";
    case LicenseTokenInvalidReason.INVALID_AUDIENCE:
      return "The license does not grant access to this resource";
    case LicenseTokenInvalidReason.SERVER_ERROR:
      return "The server encountered an error validating the license";
    default:
      return "License token missing, expired, revoked, or malformed";
  }
}

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
  const { decodeProtectedHeader } = await loadDecodeProtectedHeader();
  const { decodeJwt } = await loadDecodeJwt();
  const { jwtVerify } = await loadJwtVerify();

  if (!licenseToken) {
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.MISSING_TOKEN,
      error: reasonToErrorDescription(LicenseTokenInvalidReason.MISSING_TOKEN),
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
      error: reasonToErrorDescription(LicenseTokenInvalidReason.INVALID_HEADER),
    };
  }

  if (header.alg !== "ES256") {
    if (debug) {
      console.error("Unsupported license JWT alg:", header.alg);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_ALG,
      error: reasonToErrorDescription(LicenseTokenInvalidReason.INVALID_ALG),
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
      error: reasonToErrorDescription(LicenseTokenInvalidReason.INVALID_PAYLOAD),
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
      error: reasonToErrorDescription(LicenseTokenInvalidReason.INVALID_ISSUER),
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
      error: reasonToErrorDescription(LicenseTokenInvalidReason.INVALID_AUDIENCE),
      licenseId,
    };
  }

  const verify = async (): Promise<LicenseTokenVerificationResult> => {
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
        error: reasonToErrorDescription(LicenseTokenInvalidReason.SERVER_ERROR),
        licenseId,
      };
    }

    try {
      const getKey = async (jwtHeader: JWTHeaderParameters) => {
        const jwk = jwks.keys.find((key) => key.kid === jwtHeader.kid);
        if (!jwk) {
          throw new JwksKeyNotFoundError(jwtHeader.kid);
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

      if (error instanceof JwksKeyNotFoundError) {
        throw error;
      }

      if (error instanceof Error && error.message?.includes("exp")) {
        return {
          valid: false,
          reason: LicenseTokenInvalidReason.EXPIRED,
          error: reasonToErrorDescription(LicenseTokenInvalidReason.EXPIRED),
          licenseId,
        };
      }

      return {
        valid: false,
        reason: LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED,
        error: reasonToErrorDescription(LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED),
        licenseId,
      };
    }
  };

  try {
    return await verify();
  } catch (error) {
    if (error instanceof JwksKeyNotFoundError) {
      if (debug) {
        console.debug("Key not found in cached JWKS, clearing cache and retrying...");
      }
      clearJwksCache();
      return await verify();
    }
    throw error;
  }
}

export function generateLicenseLink({
  requestUrl,
}: {
  requestUrl: string;
}): string {
  try {
    const baseURL = new URL(requestUrl);
    return `${baseURL.protocol}//${baseURL.host}/license.xml`;
  } catch (err) {
    console.error("[SupertabConnect] generateLicenseLink failed to parse URL:", err);
    return "/license.xml";
  }
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

function reasonToRslError(reason: LicenseTokenInvalidReason | string): { rslError: string; status: number } {
  switch (reason) {
    case LicenseTokenInvalidReason.MISSING_TOKEN:
    case LicenseTokenInvalidReason.INVALID_ALG:
      return { rslError: "invalid_request", status: 401 };
    case LicenseTokenInvalidReason.EXPIRED:
    case LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED:
    case LicenseTokenInvalidReason.INVALID_HEADER:
    case LicenseTokenInvalidReason.INVALID_PAYLOAD:
    case LicenseTokenInvalidReason.INVALID_ISSUER:
      return { rslError: "invalid_token", status: 401 };
    case LicenseTokenInvalidReason.INVALID_AUDIENCE:
      return { rslError: "insufficient_scope", status: 403 };
    case LicenseTokenInvalidReason.SERVER_ERROR:
      return { rslError: "server_error", status: 503 };
    default:
      return { rslError: "invalid_token", status: 401 };
  }
}

/**
 * Sanitize a string for safe use in an HTTP header quoted-string (RFC 7230).
 * Strips CR/LF to prevent header injection and escapes backslashes and quotes.
 */
function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

export function buildBlockResult({
  reason,
  error,
  requestUrl,
}: {
  reason: LicenseTokenInvalidReason | string;
  error: string;
  requestUrl: string;
}): HandlerResult {
  const { rslError, status } = reasonToRslError(reason);
  const errorDescription = sanitizeHeaderValue(error);
  const licenseLink = generateLicenseLink({ requestUrl });

  return {
    action: HandlerAction.BLOCK,
    status,
    body: `Access to this resource requires a valid license token. Error: ${rslError} - ${error}`,
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
  try {
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
  } catch (err) {
    console.error("[SupertabConnect] hostRSLicenseXML failed:", err);
    return new Response("Bad Gateway", { status: 502 });
  }
}

export type VerifyAndRecordEventParams = {
  token: string;
  url: string;
  userAgent: string;
  supertabBaseUrl: string;
  debug: boolean;
  apiKey: string;
  ctx?: ExecutionContext;
};

export async function verifyAndRecordEvent(
  params: VerifyAndRecordEventParams
): Promise<LicenseTokenVerificationResult> {
  const verification = await verifyLicenseToken({
    licenseToken: params.token,
    requestUrl: params.url,
    supertabBaseUrl: params.supertabBaseUrl,
    debug: params.debug,
  });

  const eventPromise = recordEvent({
    apiKey: params.apiKey,
    baseUrl: params.supertabBaseUrl,
    eventName: verification.valid ? "license_used" : verification.reason,
    properties: {
      page_url: params.url,
      user_agent: params.userAgent,
      verification_status: verification.valid ? "valid" : "invalid",
      verification_reason: verification.valid ? "success" : verification.reason,
    },
    licenseId: verification.licenseId,
    debug: params.debug,
  });
  if (params.ctx?.waitUntil) {
    params.ctx.waitUntil(eventPromise);
  }

  return verification;
}
