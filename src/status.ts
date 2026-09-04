import type { JWTHeaderParameters } from "jose";
import { fetchPlatformJwks, clearJwksCache, JwksKeyNotFoundError } from "./jwks";
import { loadJwtVerify, loadDecodeJwt } from "./jose";

export interface StatusChallengeOpts {
  expectedAudience: string;
  baseUrl: string;
  debug?: boolean;
}

/**
 * Best-effort read of the challenge's `aud` claim, for diagnostics only — no signature check.
 * An `aud` mismatch is the usual self-report failure (the merchant system's stored base_url
 * diverging from the origin the edge computes, typically on scheme or an explicit default
 * port), and jose names the offending claim but not the two values that disagree.
 * @param token The challenge JWT to inspect.
 * @returns The JSON-encoded `aud` claim, or `"<undecodable>"` when the token cannot be read.
 */
async function describeAudience(token: string): Promise<string> {
  try {
    const { decodeJwt } = await loadDecodeJwt();
    return JSON.stringify(decodeJwt(token).aud ?? null);
  } catch {
    return "<undecodable>";
  }
}

/**
 * Verify the self-report status challenge JWT against the platform JWKS. Fail-closed: any
 * verification error resolves to `false` rather than throwing.
 * @param token The challenge JWT presented as `Authorization: Bearer ...`.
 * @param opts Verification options.
 * @param opts.expectedAudience Audience the challenge must carry — the origin the edge computes.
 * @param opts.baseUrl Supertab Connect API base URL the platform JWKS is fetched from.
 * @param opts.debug Enable debug logging of verification failures (default: false).
 * @returns A promise resolving to whether the challenge verified.
 */
export async function verifyStatusChallenge(token: string, opts: StatusChallengeOpts): Promise<boolean> {
  const debug = opts.debug ?? false;

  const verify = async (): Promise<boolean> => {
    const jwks = await fetchPlatformJwks(opts.baseUrl, debug);
    const { jwtVerify } = await loadJwtVerify();

    const getKey = async (jwtHeader: JWTHeaderParameters) => {
      const jwk = jwks.keys.find((key) => key.kid === jwtHeader.kid);
      if (!jwk) {
        throw new JwksKeyNotFoundError(jwtHeader.kid);
      }
      return jwk;
    };

    const { payload } = await jwtVerify(token, getKey, {
      audience: opts.expectedAudience,
      algorithms: ["ES256"],
      clockTolerance: "5s",
      // jose does not require exp by default; without it a challenge would verify forever.
      requiredClaims: ["exp", "iat"],
    });

    return payload["purpose"] === "status-probe";
  };

  try {
    return await verify();
  } catch (error) {
    if (error instanceof JwksKeyNotFoundError) {
      if (debug) {
        console.debug("Key not found in cached JWKS, clearing cache and retrying...");
      }
      clearJwksCache();
      try {
        return await verify();
      } catch (retryError) {
        if (debug) {
          console.error(
            `Status challenge verification failed after JWKS refresh (expected aud=${opts.expectedAudience}, token aud=${await describeAudience(token)}):`,
            retryError
          );
        }
        return false;
      }
    }
    if (debug) {
      console.error(
        `Status challenge verification failed (expected aud=${opts.expectedAudience}, token aud=${await describeAudience(token)}):`,
        error
      );
    }
    return false;
  }
}
