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
import { ExecutionContext, CloudFrontRequestEvent, CloudFrontHeaders } from "../src/types";

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

describe("CloudFront wrapper — RESPOND action (status endpoint)", () => {
  beforeEach(() => {
    SupertabConnect.resetInstance();
  });

  afterEach(() => {
    SupertabConnect.resetInstance();
    vi.restoreAllMocks();
  });

  // The status probe carries Authorization: Bearer, NOT x-license-auth. The wrapper's
  // early "no x-license-auth → pass to origin" short-circuit must not swallow it.
  function makeCfStatusEvent(host: string, token?: string): CloudFrontRequestEvent {
    const headers: CloudFrontHeaders = { host: [{ key: "Host", value: host }] };
    if (token) {
      headers["authorization"] = [{ key: "Authorization", value: `Bearer ${token}` }];
    }
    return {
      Records: [
        {
          cf: {
            config: { requestId: "req-1" },
            request: {
              uri: "/.well-known/supertab/status",
              method: "GET",
              querystring: "",
              headers,
              clientIp: "1.2.3.4",
            },
          },
        },
      ],
    };
  }

  it("reaches handleRequest and returns a 200 status response (valid challenge, no x-license-auth)", async () => {
    vi.spyOn(statusModule, "verifyStatusChallenge").mockResolvedValue(true);

    const result = await SupertabConnect.cloudfrontHandleRequests(
      makeCfStatusEvent("acme.com", "valid-token"),
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
      makeCfStatusEvent("acme.com", "bad-token"),
      { apiKey: "merchant-key" }
    );

    expect(result).toHaveProperty("status", "404");
    const body = JSON.parse((result as { body: string }).body);
    expect(body).toEqual({ supertab: true });
  });
});
