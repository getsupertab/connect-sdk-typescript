/**
 * When handleRequest returns a RESPOND result (e.g. for /.well-known/supertab/status),
 * the CDN wrappers must return a real HTTP response WITHOUT forwarding to origin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as statusModule from "../src/status";
import { SupertabConnect, EnforcementMode } from "../src/index";
import { makeCtx, makeStatusRequest, makeCfStatusEvent } from "./helpers/status";

describe("Cloudflare wrapper — RESPOND action (status endpoint)", () => {
  beforeEach(() => {
    SupertabConnect.resetInstance();
    // Mock verifyStatusChallenge so no real JWKS calls happen
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(true);
  });

  afterEach(() => {
    SupertabConnect.resetInstance();
    vi.restoreAllMocks();
  });

  it("returns a 200 Response with Cache-Control: no-store and does NOT call origin fetch (valid challenge)", async () => {
    // Spy on global fetch and assert it is never called
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("fetch should NOT be called for RESPOND")
    );

    const request = makeStatusRequest("valid-token");
    const ctx = makeCtx();
    const env = { MERCHANT_API_KEY: "test-api-key" };

    const response = await SupertabConnect.cloudflareHandleRequests(
      request,
      env,
      ctx,
      { enforcement: EnforcementMode.OBSERVE }
    );

    // Should be a real 200 response, not forwarded to origin
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    // Body should be valid JSON with expected fields
    const body = await response.json();
    expect(body).toMatchObject({
      sdkVersion: expect.any(String),
      enforcement: EnforcementMode.OBSERVE,
    });
    expect(body).not.toHaveProperty("servingLicenseXml");

    // Origin fetch must NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a 404 Response and does NOT call origin fetch (invalid challenge)", async () => {
    // Reset the mock to return false (invalid challenge)
    vi.restoreAllMocks();
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(false);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("fetch should NOT be called for RESPOND")
    );

    const request = makeStatusRequest("bad-token");
    const ctx = makeCtx();
    const env = { MERCHANT_API_KEY: "test-api-key" };

    const response = await SupertabConnect.cloudflareHandleRequests(
      request,
      env,
      ctx
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = await response.json();
    expect(body).toEqual({ supertab: true });

    // Origin fetch must NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("CloudFront wrapper — RESPOND action (status endpoint)", () => {
  beforeEach(() => {
    SupertabConnect.resetInstance();
  });

  afterEach(() => {
    SupertabConnect.resetInstance();
    vi.restoreAllMocks();
  });

  it("reaches handleRequest and returns a 200 status response (valid challenge, no x-license-auth)", async () => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(true);

    const result = await SupertabConnect.cloudfrontHandleRequests(
      makeCfStatusEvent("valid-token"),
      { apiKey: "merchant-key", enforcement: EnforcementMode.OBSERVE }
    );

    // A CloudFront response result has `status`; a pass-through result would be the raw request (has `uri`).
    expect(result).toHaveProperty("status", "200");
    expect(result).not.toHaveProperty("uri");
    const body = JSON.parse((result as { body: string }).body);
    expect(body).toMatchObject({ enforcement: EnforcementMode.OBSERVE });
    expect(body).not.toHaveProperty("servingLicenseXml");
  });

  it("returns a 404 status response for an invalid challenge (still reached handleRequest)", async () => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(false);

    const result = await SupertabConnect.cloudfrontHandleRequests(
      makeCfStatusEvent("bad-token"),
      { apiKey: "merchant-key" }
    );

    expect(result).toHaveProperty("status", "404");
    const body = JSON.parse((result as { body: string }).body);
    expect(body).toEqual({ supertab: true });
  });
});
