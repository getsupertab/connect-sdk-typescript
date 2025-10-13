import {
  decodeProtectedHeader,
  decodeJwt,
  JWTPayload,
  JWTHeaderParameters,
  jwtVerify,
} from "jose";
import {
  LicenseTokenInvalidReason,
  LicenseTokenVerificationResult,
} from "./types";
import { fetchPlatformJwks } from "./jwks";

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

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

  let payload: JWTPayload;
  try {
    payload = decodeJwt(licenseToken);
  } catch (error) {
    if (debug) {
      console.error("Invalid license JWT payload:", error);
    }
    return {
      valid: false,
      reason: LicenseTokenInvalidReason.INVALID_PAYLOAD,
    };
  }

  // @ts-ignore
  const licenseId: string | undefined = payload.license_id;

  const issuer: string | undefined = payload.iss;
  if (!issuer || !issuer.startsWith(supertabBaseUrl)) {
    if (debug) {
      console.error("Invalid license JWT issuer:", issuer);
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

  try {
    const jwks = await fetchPlatformJwks(supertabBaseUrl, debug);

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
  supertabBaseUrl,
  merchantSystemUrn,
}: {
  supertabBaseUrl: string;
  merchantSystemUrn?: string;
}): string {
  return `${supertabBaseUrl}/merchants/systems/${merchantSystemUrn}/license.xml`;
}

type RecordEventFn = (
  eventName: string,
  properties?: Record<string, any>,
  licenseId?: string,
) => Promise<void>;

type BaseLicenseHandleRequestParams = {
  licenseToken: string;
  url: string;
  userAgent: string;
  ctx: any;
  supertabBaseUrl: string;
  merchantSystemUrn?: string;
  debug: boolean;
  recordEvent: RecordEventFn;
};

export async function baseLicenseHandleRequest({
  licenseToken,
  url,
  userAgent,
  ctx,
  supertabBaseUrl,
  merchantSystemUrn,
  debug,
  recordEvent,
}: BaseLicenseHandleRequestParams): Promise<Response> {
  const verification = await verifyLicenseToken({
    licenseToken,
    requestUrl: url,
    supertabBaseUrl,
    debug,
  });

  async function recordLicenseEvent(eventName: string) {
    const eventProperties = {
      page_url: url,
      user_agent: userAgent,
      verification_status: verification.valid ? "valid" : "invalid",
      verification_reason: verification.reason || "success",
    };

    const eventPromise = recordEvent(
      eventName,
      eventProperties,
      verification.licenseId,
    );

    if (ctx?.waitUntil) {
      ctx.waitUntil(eventPromise);
    }

    return eventPromise;
  }

  if (!verification.valid) {
    await recordLicenseEvent(
      verification.reason || "license_token_verification_failed"
    );

    let rslError = "invalid_request";
    let errorDescription = "Access to this resource requires a license";

    switch (verification.reason) {
      case LicenseTokenInvalidReason.MISSING_TOKEN:
        rslError = "invalid_request";
        errorDescription = "Access to this resource requires a license";
        break;
      case LicenseTokenInvalidReason.EXPIRED:
        rslError = "invalid_token";
        errorDescription = "The license token has expired";
        break;
      case LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED:
      case LicenseTokenInvalidReason.INVALID_HEADER:
      case LicenseTokenInvalidReason.INVALID_PAYLOAD:
        rslError = "invalid_token";
        errorDescription = "The license token is invalid";
        break;
      case LicenseTokenInvalidReason.INVALID_ISSUER:
        rslError = "invalid_token";
        errorDescription = "The license token issuer is invalid";
        break;
      case LicenseTokenInvalidReason.INVALID_AUDIENCE:
        rslError = "invalid_token";
        errorDescription = "The license token audience is invalid";
        break;
      default:
        rslError = "invalid_request";
        errorDescription = "Access to this resource requires a license";
    }

    const licenseLink = generateLicenseLink({
      supertabBaseUrl,
      merchantSystemUrn,
    });
    const errorUri = `${supertabBaseUrl}/docs/errors#${rslError}`;

    const headers = new Headers({
      "Content-Type": "text/plain; charset=UTF-8",
      "WWW-Authenticate": `License error="${rslError}", error_description="${errorDescription}", error_uri="${errorUri}"`,
      Link: `${licenseLink}; rel="license"; type="application/rsl+xml"`,
    });

    const responseBody = `Access to this resource requires a valid license token. Error: ${rslError} - ${errorDescription}`;

    return new Response(responseBody, {
      status: 401,
      headers,
    });
  }

  await recordLicenseEvent("license_used");
  return new Response("✅ License Token Access granted", {
    status: 200,
    headers: new Headers({ "Content-Type": "application/json" }),
  });
}
