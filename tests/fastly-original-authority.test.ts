import { describe, it, expect, vi, afterEach } from "vitest";
import { SupertabConnect } from "../src/index";
import { setConnectBackend } from "../src/fastly-backend";
import { clearJwksCache } from "../src/jwks";

// The Compute service's own domain — what `override_host` leaves in Host on a VCL chain.
const COMPUTE_URL = "https://svc.edgecompute.app/article";

function fastlyEvent(headers: Record<string, string> = {}, url = COMPUTE_URL) {
  return {
    request: new Request(url, { headers }),
    client: { address: "1.2.3.4", geo: null, tlsJA3MD5: null },
    waitUntil: () => {},
  };
}

// OBSERVE + a bot + no token takes the buildSignalResult path, whose `Link: rel="license"`
// header is built from the request URL. That makes the recovered authority observable from
// outside the SDK, through the public entry point.
async function licenseLink(options: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  vi.stubGlobal("fastly", {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

  const response = await SupertabConnect.fastlyHandleRequests(
    fastlyEvent(headers) as any,
    "api-key",
    "content_origin",
    { botDetector: () => true, ...options } as any
  );
  return response.headers.get("Link");
}

afterEach(() => {
  setConnectBackend(undefined);
  SupertabConnect.resetInstance();
  clearJwksCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fastlyHandleRequests preserved authority", () => {
  it("builds the license Link from the preserved authority on a VCL chain", async () => {
    const link = await licenseLink({}, { "x-supertab-original-authority": "www.example.com" });
    expect(link).toContain("https://www.example.com/license.xml");
    expect(link).not.toContain("edgecompute.app");
  });

  it("honours a custom originalAuthorityHeader name", async () => {
    const link = await licenseLink(
      { originalAuthorityHeader: "x-supertab-viewer-host" },
      { "x-supertab-viewer-host": "www.example.com" }
    );
    expect(link).toContain("https://www.example.com/license.xml");
  });

  it("ignores the default header once a custom name is configured", async () => {
    const link = await licenseLink(
      { originalAuthorityHeader: "x-supertab-viewer-host" },
      { "x-supertab-original-authority": "www.example.com" }
    );
    expect(link).toContain("https://svc.edgecompute.app/license.xml");
  });

  it("falls back to the compute host when no header is present", async () => {
    const link = await licenseLink();
    expect(link).toContain("https://svc.edgecompute.app/license.xml");
  });

  it("ignores a forged header value that is not a bare authority", async () => {
    const link = await licenseLink({}, { "x-supertab-original-authority": "https://evil.example/x" });
    expect(link).toContain("https://svc.edgecompute.app/license.xml");
    expect(link).not.toContain("evil.example");
  });
});
