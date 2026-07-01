import { describe, it, expect, beforeAll, beforeEach, onTestFailed } from "vitest";
import { ENVIRONMENTS } from "./config";

// ============================================================================
// Self-report status endpoint — e2e reachability check
// ============================================================================
//
// Hits a RUNNING worker's `/.well-known/supertab/status` and asserts the
// unauthenticated / invalid-challenge path: a minimal `{"supertab":true}` 404
// with `Cache-Control: no-store`. This proves the endpoint is wired and
// correctly refuses to leak config to a probe without a valid, backend-minted
// challenge — on the real runtime, not a mock.
//
// The 200 self-report path is intentionally NOT covered here: the status-probe
// challenge can only be minted by the backend (there is no client-credentials
// flow that yields one), so it cannot be produced from this client-side
// harness the way `enforcement.test.ts` obtains a license token. The full
// backend↔SDK 200 path is proven from the backend repo
// (`src/tests/e2e/test_self_report_e2e.py` + its runbook).
//
// OPT-IN: gated on STATUS_E2E=1 so the default `vitest run` stays green even
// when the selected deployment has not yet shipped the endpoint. Run against a
// deployment (or local worker) that serves it, e.g.:
//
//   STATUS_E2E=1 TEST_ENV=local-cloudflare npx vitest run tests/e2e/status-e2e.test.ts
//
// (local-cloudflare = the cloudflare demo via `wrangler dev --port 8788`.)

const STATUS_PATH = "/.well-known/supertab/status";
const TEST_ENV = process.env.TEST_ENV || "local-cloudflare";
const config = ENVIRONMENTS[TEST_ENV] || ENVIRONMENTS.local;

// The status endpoint is served from the deployment origin, independent of the
// article path used by the enforcement suite.
const statusUrl = new URL(STATUS_PATH, config.resourceUrl).toString();

const RUN = process.env.STATUS_E2E === "1";
const describeStatus = RUN ? describe : describe.skip;

let logBuffer: string[] = [];
const log = (msg: string) => logBuffer.push(msg);

beforeAll(() => {
  console.log(`\nStatus E2E Configuration:`);
  console.log(`  Environment: ${TEST_ENV}`);
  console.log(`  Status URL: ${statusUrl}`);
  console.log(`  Enabled: ${RUN} (set STATUS_E2E=1 to run)\n`);
});

beforeEach(() => {
  logBuffer = [];
  onTestFailed(() => {
    console.log("\n--- Debug logs for failed test ---");
    logBuffer.forEach((line) => console.log(line));
    console.log("--- End debug logs ---\n");
  });
});

async function probeStatus(headers: Record<string, string>): Promise<Response> {
  const response = await fetch(statusUrl, { method: "GET", headers });
  log(`[probeStatus] ${JSON.stringify(headers)} -> ${response.status}`);
  return response;
}

describeStatus("Self-report status endpoint (reachability)", () => {
  it("returns 404 {supertab:true} with no-store when no challenge is present", async () => {
    const response = await probeStatus({});
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ supertab: true });
  }, 30000);

  it("returns 404 {supertab:true} for an invalid challenge", async () => {
    const response = await probeStatus({ Authorization: "Bearer not.a.real.jwt" });
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ supertab: true });
  }, 30000);
});
