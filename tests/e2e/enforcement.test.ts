import { describe, it, expect, beforeAll } from "vitest";
import { SupertabConnect } from "../../src/index";
import { ENVIRONMENTS } from "./config";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_BASE_URL = "https://api-connect.supertab.co";

// Test modes - must match server configuration
enum TestMode {
  DISABLED = "disabled",
  SOFT_NO_BOT_DETECTION = "soft-no-bot-detection",
  STRICT_NO_BOT_DETECTION = "strict-no-bot-detection",
  SOFT_BOT_DETECTION = "soft-bot-detection",
  STRICT_BOT_DETECTION = "strict-bot-detection",
}

// Change this to switch test mode, or use TEST_MODE env var
const DEFAULT_TEST_MODE = TestMode.SOFT_NO_BOT_DETECTION;

const TEST_MODE = process.env.TEST_MODE || DEFAULT_TEST_MODE;

// Environment selection - single var picks full config
const TEST_ENV = process.env.TEST_ENV || "local";

const config = ENVIRONMENTS[TEST_ENV] || ENVIRONMENTS.local;

// ============================================================================
// User Agent Constants
// ============================================================================

const USER_AGENTS = {
  bot: "curl/7.64.1",
  browser:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// ============================================================================
// Fetch Helper
// ============================================================================

interface FetchOptions {
  userAgent: "bot" | "browser";
  token: "none" | "valid" | "invalid";
}

async function fetchResource(options: FetchOptions): Promise<Response> {
  const { userAgent, token } = options;

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENTS[userAgent],
  };

  if (token === "valid") {
    const clientSecret = config.clientSecret ?? "";
    const signedLicense = await SupertabConnect.obtainLicenseToken(
      config.clientId,
      clientSecret,
      config.resourceUrl,
      true
    );
    headers.Authorization = `License ${signedLicense}`;
  } else if (token === "invalid") {
    headers.Authorization = "License invalid.token.here";
  }

  const response = await fetch(config.resourceUrl, {
    method: "GET",
    headers,
  });

  return response;
}

// ============================================================================
// Conditional Test Suite Helper
// ============================================================================

const describeMode = (mode: string) =>
  TEST_MODE === mode ? describe : describe.skip;

// ============================================================================
// Test Setup
// ============================================================================

beforeAll(() => {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  SupertabConnect.setBaseUrl(baseUrl);
  console.log(`\nTest Configuration:`);
  console.log(`  Environment: ${TEST_ENV}`);
  console.log(`  Test Mode: ${TEST_MODE}`);
  console.log(`  Base URL: ${baseUrl}`);
  console.log(`  Resource URL: ${config.resourceUrl}\n`);
});

// ============================================================================
// disabled - Enforcement off, everything passes
// ============================================================================

describeMode(TestMode.DISABLED)("Disabled Mode", () => {
  it("no token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "none" });
    expect(response.status).toBe(200);
  });

  it("valid token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "valid" });
    expect(response.status).toBe(200);
  });

  it("invalid token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "invalid" });
    expect(response.status).toBe(200);
  });
});

// ============================================================================
// soft-no-bot-detection - Soft enforcement, bot detection OFF
// ============================================================================

describeMode(TestMode.SOFT_NO_BOT_DETECTION)("Soft Mode (No Bot Detection)", () => {
  it("no token gets 200 without headers", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "none" });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RSL-Status")).toBeNull();
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("valid token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "valid" });
    expect(response.status).toBe(200);
  }, 30000);  // increase timeout to 30s

  it("invalid token gets 401", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "invalid" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
  });
});

// ============================================================================
// strict-no-bot-detection - Strict enforcement, bot detection OFF
// ============================================================================

describeMode(TestMode.STRICT_NO_BOT_DETECTION)("Strict Mode (No Bot Detection)", () => {
  it("no token gets 200 without headers", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "none" });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RSL-Status")).toBeNull();
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("valid token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "valid" });
    expect(response.status).toBe(200);
  });

  it("invalid token gets 401", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "invalid" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
  });
});

// ============================================================================
// soft-bot-detection - Soft enforcement, bot detection ON
// ============================================================================

describeMode(TestMode.SOFT_BOT_DETECTION)("Soft Mode (Bot Detection ON)", () => {
  it("bot + no token gets 200 with signal headers", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "none" });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RSL-Status")).toBe("token_required");
    expect(response.headers.get("Link")).toBeTruthy();
  });

  it("bot + valid token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "valid" });
    expect(response.status).toBe(200);
  });

  it("bot + invalid token gets 401", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "invalid" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    expect(response.headers.get("Link")).toBeTruthy();
  });
});

// ============================================================================
// strict-bot-detection - Strict enforcement, bot detection ON
// ============================================================================

describeMode(TestMode.STRICT_BOT_DETECTION)("Strict Mode (Bot Detection ON)", () => {
  it("bot + no token gets 401 with WWW-Authenticate", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "none" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    expect(response.headers.get("Link")).toBeTruthy();
  });

  it("bot + valid token gets 200", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "valid" });
    expect(response.status).toBe(200);
  });

  it("bot + invalid token gets 401", async () => {
    const response = await fetchResource({ userAgent: "bot", token: "invalid" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    expect(response.headers.get("Link")).toBeTruthy();
  });
});
