import { describe, it, expect, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import * as jwks from "../src/jwks";
import { verifyStatusChallenge } from "../src/status";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid"; jwk.alg = "ES256";
  vi.spyOn(jwks, "fetchPlatformJwks").mockResolvedValue({ keys: [jwk] } as never);
  return { privateKey };
}

function sign(privateKey: CryptoKey, claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .setIssuedAt().setExpirationTime("60s").sign(privateKey);
}

describe("verifyStatusChallenge", () => {
  it("accepts a valid challenge", async () => {
    const { privateKey } = await setup();
    const token = await sign(privateKey, { aud: "https://acme.com", purpose: "status-probe" });
    expect(await verifyStatusChallenge(token, { expectedAudience: "https://acme.com", baseUrl: "https://api" })).toBe(true);
  });

  it("rejects wrong purpose / wrong audience", async () => {
    const { privateKey } = await setup();
    const wrongPurpose = await sign(privateKey, { aud: "https://acme.com", purpose: "nope" });
    const wrongAud = await sign(privateKey, { aud: "https://evil.com", purpose: "status-probe" });
    expect(await verifyStatusChallenge(wrongPurpose, { expectedAudience: "https://acme.com", baseUrl: "https://api" })).toBe(false);
    expect(await verifyStatusChallenge(wrongAud, { expectedAudience: "https://acme.com", baseUrl: "https://api" })).toBe(false);
  });

  it("rejects an expired challenge", async () => {
    const { privateKey } = await setup();
    const expiredToken = await new SignJWT({ aud: "https://acme.com", purpose: "status-probe" })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setIssuedAt()
      .setExpirationTime("-10s")
      .sign(privateKey);
    expect(await verifyStatusChallenge(expiredToken, { expectedAudience: "https://acme.com", baseUrl: "https://api" })).toBe(false);
  });
});
