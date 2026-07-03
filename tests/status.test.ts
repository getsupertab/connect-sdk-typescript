import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import * as jwks from "../src/jwks";
import { verifyStatusChallenge } from "../src/status";
import * as statusModule from "../src/status";
import { SupertabConnect, HandlerAction } from "../src/index";
import { EnforcementMode } from "../src/types";
import { makeStatusRequest, RecordingTransport } from "./helpers/status";

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

  it("retries with refreshed JWKS after key rotation (JwksKeyNotFoundError on first fetch)", async () => {
    // Generate the signing key pair
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "rotated-kid";
    jwk.alg = "ES256";

    // First fetch returns JWKS without the signing key (stale cache — old kid)
    const staleJwks = { keys: [{ kid: "old-kid", alg: "ES256", kty: "EC" }] };
    // Second fetch returns JWKS with the correct (rotated) key
    const freshJwks = { keys: [jwk] };

    const fetchSpy = vi.spyOn(jwks, "fetchPlatformJwks")
      .mockResolvedValueOnce(staleJwks as never)
      .mockResolvedValueOnce(freshJwks as never);

    const clearCacheSpy = vi.spyOn(jwks, "clearJwksCache");

    const token = await new SignJWT({ aud: "https://acme.com", purpose: "status-probe" })
      .setProtectedHeader({ alg: "ES256", kid: "rotated-kid" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(privateKey);

    const result = await verifyStatusChallenge(token, {
      expectedAudience: "https://acme.com",
      baseUrl: "https://api",
    });

    expect(result).toBe(true);
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it("resolves false (not throws) when BOTH fetches lack the signing key (retry exhausted)", async () => {
    // Both fetches return JWKS without the signing key
    const staleJwks = { keys: [{ kid: "old-kid", alg: "ES256", kty: "EC" }] };

    const fetchSpy = vi.spyOn(jwks, "fetchPlatformJwks")
      .mockResolvedValueOnce(staleJwks as never)
      .mockResolvedValueOnce(staleJwks as never);

    const clearCacheSpy = vi.spyOn(jwks, "clearJwksCache");

    // Sign with a key whose kid matches neither fetch
    const { privateKey } = await generateKeyPair("ES256");
    const token = await new SignJWT({ aud: "https://acme.com", purpose: "status-probe" })
      .setProtectedHeader({ alg: "ES256", kid: "rotated-kid" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(privateKey);

    const result = await verifyStatusChallenge(token, {
      expectedAudience: "https://acme.com",
      baseUrl: "https://api",
    });

    expect(result).toBe(false);
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });
});

describe("handleRequest — /.well-known/supertab/status branch", () => {
  beforeEach(() => {
    SupertabConnect.resetInstance();
  });

  afterEach(() => {
    SupertabConnect.resetInstance();
    vi.restoreAllMocks();
  });

  it("returns RESPOND with status 200 and correct payload on valid challenge", async () => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(true);

    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.ENFORCE,
      analyticsEnabled: true,
      analyticsTransport: transport,
    }, true);

    const result = await sdk.handleRequest(makeStatusRequest("valid-token"));

    expect(result.action).toBe(HandlerAction.RESPOND);
    if (result.action !== HandlerAction.RESPOND) return;

    expect(result.status).toBe(200);

    const body = JSON.parse(result.body);
    expect(body.enforcement).toBe(EnforcementMode.ENFORCE);
    expect(body.eventReporting).toBe(true);
    // No context passed → runtime is null.
    expect(body.runtime).toBeNull();
    expect(body).not.toHaveProperty("servingLicenseXml");
    expect(body).not.toHaveProperty("merchantUrn");

    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("reports runtime from context.sourceCdn and eventReporting=false when analytics is off", async () => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(true);

    const sdk = new SupertabConnect({ apiKey: "merchant-key" }, true);
    const result = await sdk.handleRequest(makeStatusRequest("valid-token"), { sourceCdn: "cloudflare" });

    expect(result.action).toBe(HandlerAction.RESPOND);
    if (result.action !== HandlerAction.RESPOND) return;

    const body = JSON.parse(result.body);
    expect(body.runtime).toBe("cloudflare");
    expect(body.eventReporting).toBe(false);
  });

  it("returns RESPOND with status 404 and minimal body on invalid challenge", async () => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(false);

    const sdk = new SupertabConnect({ apiKey: "merchant-key" }, true);
    const result = await sdk.handleRequest(makeStatusRequest("invalid-token"));

    expect(result.action).toBe(HandlerAction.RESPOND);
    if (result.action !== HandlerAction.RESPOND) return;

    expect(result.status).toBe(404);
    const body = JSON.parse(result.body);
    expect(body).toEqual({ supertab: true });

    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("returns 404 when Authorization header is absent", async () => {
    // verifyStatusChallenge should NOT be called at all when there's no token
    const verifySpy = vi.spyOn(statusModule, "verifyStatusChallenge");

    const sdk = new SupertabConnect({ apiKey: "merchant-key" }, true);
    const result = await sdk.handleRequest(makeStatusRequest()); // no Bearer token

    expect(result.action).toBe(HandlerAction.RESPOND);
    if (result.action !== HandlerAction.RESPOND) return;

    expect(result.status).toBe(404);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it.each([
    { label: "valid challenge", valid: true, token: "valid-token" },
    { label: "invalid challenge", valid: false, token: "bad-token" },
  ])("does NOT emit any analytics events for a status request ($label)", async ({ valid, token }) => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(valid);

    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      analyticsTransport: transport,
    }, true);

    await sdk.handleRequest(makeStatusRequest(token));

    expect(transport.events).toHaveLength(0);
  });
});
