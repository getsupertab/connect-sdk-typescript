import type { JWTHeaderParameters } from "jose";
import { fetchPlatformJwks, JwksKeyNotFoundError } from "./jwks";
import { loadJwtVerify } from "./jose";

export interface StatusChallengeOpts {
  expectedAudience: string;
  baseUrl: string;
  debug?: boolean;
}

export async function verifyStatusChallenge(token: string, opts: StatusChallengeOpts): Promise<boolean> {
  try {
    const jwks = await fetchPlatformJwks(opts.baseUrl, opts.debug ?? false);
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
    });

    return payload["purpose"] === "status-probe";
  } catch {
    return false;
  }
}
