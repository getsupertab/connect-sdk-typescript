import type { JWTHeaderParameters } from "jose";
import { fetchPlatformJwks, clearJwksCache, JwksKeyNotFoundError } from "./jwks";
import { loadJwtVerify } from "./jose";

export interface StatusChallengeOpts {
  expectedAudience: string;
  baseUrl: string;
  debug?: boolean;
}

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
          console.error("Status challenge verification failed after JWKS refresh:", retryError);
        }
        return false;
      }
    }
    if (debug) {
      console.error("Status challenge verification failed:", error);
    }
    return false;
  }
}
