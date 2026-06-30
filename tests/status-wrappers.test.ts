/**
 * Tests for Task S3: RESPOND HandlerAction wired through CDN wrappers.
 *
 * These tests verify that when handleRequest returns a RESPOND result
 * (e.g., for /.well-known/supertab/status), the CDN wrappers return
 * a real HTTP response WITHOUT forwarding to origin (no fetch call).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as statusModule from "../src/status";
import { SupertabConnect, EnforcementMode } from "../src/index";
import { ExecutionContext } from "../src/types";

// A minimal ExecutionContext stub that satisfies the interface
function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn() };
}

// Build a Request to /.well-known/supertab/status with a bearer token
function makeStatusRequest(origin: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new Request(`${origin}/.well-known/supertab/status`, {
    method: "GET",
    headers,
  });
}

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

    const request = makeStatusRequest("https://acme.com", "valid-token");
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
      servingLicenseXml: true,
    });

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

    const request = makeStatusRequest("https://acme.com", "bad-token");
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
