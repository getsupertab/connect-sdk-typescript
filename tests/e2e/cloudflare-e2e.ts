/**
 * Cloudflare analytics-pipeline E2E harness.
 *
 * Runs the SDK inside `wrangler dev` (workerd, the production runtime), walks
 * the emission branches in `handleRequest`, and asserts each one lands a row in
 * `bot_events_raw` with the right `source_cdn` / `client_ip` / `token_outcome`
 * / `final_action` / `enforcement_mode`.
 *
 * Requires a backend whose `/ingest/events` relay persists to Tinybird
 * (STC-609+). In the relay model the Worker POSTs analytics to
 * `${SUPERTAB_BASE_URL}/ingest/events` (Bearer merchant API key); the backend
 * stamps the merchant URN and forwards the row to Tinybird.
 *
 * NOTE vs. the prototype: the relay analytics event no longer carries a
 * `bot_detector_result` column (removed with the policy-lookup pivot), so this
 * harness does not assert on it.
 *
 * Different concern from `tests/e2e/enforcement.test.ts`:
 *   - enforcement.test.ts asserts on **HTTP responses** (status, headers) — Worker behavior.
 *   - this file asserts on **Tinybird rows** — analytics pipeline integrity.
 *
 * Config: pick TEST_ENV (default local-cloudflare). Worker URL, Tinybird host,
 * and merchant URN come from tests/e2e/config.ts (same source as
 * enforcement.test.ts). TB_ADMIN_TOKEN is a secret and stays an env var. Any of
 * WORKER_URL / TB_URL / MERCHANT_SYSTEM_URN / ORIGIN_PORT still override.
 *
 * This is LOCAL/sandbox only — it needs ALLOW_TEST_OVERRIDES=true on the Worker
 * to drive every enforcement/bot-detection branch, so don't point it at prod.
 *
 * Prerequisites:
 *   - Tinybird Local:  cd ../supertab-connect/tinybird && uv run tinybird local start
 *   - Backend:         Supertab Connect backend with /ingest/events persisting to
 *                      Tinybird (TINYBIRD_HOST/TINYBIRD_TOKEN set), at SUPERTAB_BASE_URL
 *   - Worker:          cd demos/cloudflare && npx wrangler dev --port 8788 --ip 127.0.0.1
 *                      (.dev.vars must have ALLOW_TEST_OVERRIDES=true AND
 *                       ANALYTICS_ENABLED=true)
 *
 * Run from the SDK repo root:
 *   TB_ADMIN_TOKEN=… npx tsx tests/e2e/cloudflare-e2e.ts
 */

// origin.ts resolves as CommonJS (demos/cloudflare/package.json has no
// "type":"module"), so a named ESM import of startOrigin fails at runtime.
// Import the default (module.exports) and pull startOrigin off it.
import type { OriginHandle } from "../../demos/cloudflare/origin";
import originModule from "../../demos/cloudflare/origin";
const { startOrigin } = originModule as typeof import("../../demos/cloudflare/origin");
import { ENVIRONMENTS, type EnvironmentConfig } from "./config";
import { createTinybirdClient, createExpect } from "./tinybird-helpers";

// Resolve targets from the selected env (config.ts); env vars override.
const TEST_ENV = process.env.TEST_ENV || "local-cloudflare";
const cfg: Partial<EnvironmentConfig> = ENVIRONMENTS[TEST_ENV] ?? {};

const WORKER_URL =
  process.env.WORKER_URL ?? (cfg.resourceUrl ? new URL(cfg.resourceUrl).origin : "http://127.0.0.1:8788");
const TB_URL = process.env.TB_URL ?? process.env.TB_LOCAL_URL ?? cfg.tinybirdUrl ?? "http://localhost:7181";
const TB_ADMIN_TOKEN = process.env.TB_ADMIN_TOKEN; // secret — env only
const MERCHANT_SYSTEM_URN = process.env.MERCHANT_SYSTEM_URN ?? cfg.merchantSystemUrn;
const ORIGIN_PORT = Number(process.env.ORIGIN_PORT ?? 8789);

if (!TB_ADMIN_TOKEN) {
  console.error(
    "Set TB_ADMIN_TOKEN to a Tinybird Local workspace admin token " +
      "(`cd ../supertab-connect/tinybird && uv run tinybird --local token ls`).",
  );
  process.exit(1);
}
if (!MERCHANT_SYSTEM_URN) {
  console.error("Set MERCHANT_SYSTEM_URN to the merchant system behind the demo's MERCHANT_API_KEY.");
  process.exit(1);
}

const RUN_ID = Date.now().toString(36);
const PATH_PREFIX = `/cf-e2e-${RUN_ID}`;

type FinalAction = "allow" | "observe" | "block";
type EnforcementMode = "observe" | "enforce" | "disabled";

interface Scenario {
  name: string;
  path: string;
  clientIp: string;
  headers: Record<string, string>;
  /** Set on the harness side via `X-Test-Enforcement`. */
  enforcement: EnforcementMode;
  /** Set on the harness side via `X-Test-Bot-Detection`. */
  botDetection: boolean;
  /** Range of acceptable HTTP statuses; empty = don't assert. */
  acceptStatus: number[];
  expected: {
    source_cdn: "cloudflare";
    client_ip: string;
    has_token: boolean;
    token_outcome: string;
    final_action: FinalAction;
    enforcement_mode: EnforcementMode;
  };
}

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADLESS_UA = "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0";

const scenarios: Scenario[] = [
  {
    name: "1. human + no token + OBSERVE → allow",
    path: `${PATH_PREFIX}/human`,
    clientIp: "198.51.100.1",
    enforcement: "observe",
    botDetection: true,
    headers: {
      "User-Agent": HUMAN_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://search.example.com/",
    },
    acceptStatus: [200],
    expected: {
      source_cdn: "cloudflare",
      client_ip: "::ffff:198.51.100.1",
      has_token: false,
      token_outcome: "absent",
      final_action: "allow",
      enforcement_mode: "observe",
    },
  },
  {
    name: "2. GPTBot + no token + OBSERVE → observe",
    path: `${PATH_PREFIX}/gptbot-observe`,
    clientIp: "198.51.100.2",
    enforcement: "observe",
    botDetection: true,
    headers: { "User-Agent": "GPTBot/1.0" },
    acceptStatus: [200],
    expected: {
      source_cdn: "cloudflare",
      client_ip: "::ffff:198.51.100.2",
      has_token: false,
      token_outcome: "absent",
      final_action: "observe",
      enforcement_mode: "observe",
    },
  },
  {
    name: "3. ClaudeBot + no token + ENFORCE → block",
    path: `${PATH_PREFIX}/claudebot-enforce`,
    clientIp: "198.51.100.3",
    enforcement: "enforce",
    botDetection: true,
    headers: { "User-Agent": "ClaudeBot/1.0" },
    // Don't pin the status — the SDK's bot-block status (401/402/403) is
    // implementation detail; final_action='block' in Tinybird is the truth.
    acceptStatus: [],
    expected: {
      source_cdn: "cloudflare",
      client_ip: "::ffff:198.51.100.3",
      has_token: false,
      token_outcome: "absent",
      final_action: "block",
      enforcement_mode: "enforce",
    },
  },
  {
    name: "4. GPTBot + no token + DISABLED → allow",
    path: `${PATH_PREFIX}/gptbot-disabled`,
    clientIp: "198.51.100.5",
    enforcement: "disabled",
    botDetection: true,
    headers: { "User-Agent": "GPTBot/1.0" },
    acceptStatus: [200],
    expected: {
      source_cdn: "cloudflare",
      client_ip: "::ffff:198.51.100.5",
      has_token: false,
      token_outcome: "absent",
      final_action: "allow",
      enforcement_mode: "disabled",
    },
  },
  {
    name: "5. GPTBot + malformed License + OBSERVE → block/malformed",
    path: `${PATH_PREFIX}/malformed-token`,
    clientIp: "198.51.100.6",
    enforcement: "observe",
    botDetection: true, // ignored — SDK skips bot detection on token-present path
    headers: {
      "User-Agent": "GPTBot/1.0",
      Authorization: "License not-a-real-jwt",
    },
    acceptStatus: [401],
    expected: {
      source_cdn: "cloudflare",
      client_ip: "::ffff:198.51.100.6",
      has_token: true,
      token_outcome: "malformed",
      final_action: "block",
      enforcement_mode: "observe",
    },
  },
];

async function preflight(): Promise<void> {
  try {
    const res = await fetch(WORKER_URL, {
      headers: { "User-Agent": "cf-e2e-preflight", "CF-Connecting-IP": "127.0.0.1" },
    });
    if (res.status >= 500 && res.status !== 503) {
      throw new Error(`worker returned ${res.status}`);
    }
  } catch (err) {
    console.error(`Pre-flight failed: cannot reach worker at ${WORKER_URL}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
    console.error("Start the worker:  cd demos/cloudflare && npx wrangler dev --port 8788 --ip 127.0.0.1");
    console.error("Make sure .dev.vars has  ALLOW_TEST_OVERRIDES=true  and  ANALYTICS_ENABLED=true");
    process.exit(1);
  }

  const tbRes = await fetch(`${TB_URL}/v0/health`).catch(() => null);
  if (!tbRes || !tbRes.ok) {
    console.error(`Pre-flight failed: Tinybird Local not healthy at ${TB_URL}`);
    console.error("Start it: cd ../supertab-connect/tinybird && uv run tinybird local start");
    process.exit(1);
  }
}

async function hitWorker(scenario: Scenario): Promise<number> {
  const res = await fetch(`${WORKER_URL}${scenario.path}`, {
    method: "GET",
    headers: {
      ...scenario.headers,
      "CF-Connecting-IP": scenario.clientIp,
      "X-Test-Enforcement": scenario.enforcement,
      "X-Test-Bot-Detection": scenario.botDetection ? "true" : "false",
    },
    redirect: "manual",
  });
  await res.text().catch(() => "");
  return res.status;
}

const tb = createTinybirdClient(TB_URL, TB_ADMIN_TOKEN!);
const { expect, fail, count } = createExpect();

async function quarantineCount(): Promise<number> {
  try {
    const resp = await tb.querySql("SELECT count() AS c FROM bot_events_raw_quarantine");
    return Number((resp.data?.[0] as { c?: number })?.c ?? 0);
  } catch (err) {
    if (String(err).includes("Datasource") || String(err).includes("not found")) return 0;
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(`run_id=${RUN_ID}`);
  console.log(`merchant_system_urn=${MERCHANT_SYSTEM_URN}`);
  console.log(`worker=${WORKER_URL}`);
  console.log(`tinybird=${TB_URL}`);
  console.log(`path_prefix=${PATH_PREFIX}`);
  console.log("---");

  // Prefer to own the origin in-process. If something's already bound to
  // ORIGIN_PORT (a manually-started origin), reuse it.
  let origin: OriginHandle | null = null;
  try {
    origin = await startOrigin(ORIGIN_PORT);
    console.log(`publisher origin up on http://127.0.0.1:${origin.port}`);
  } catch (err) {
    if (String(err).includes("EADDRINUSE")) {
      const probe = await fetch(`http://127.0.0.1:${ORIGIN_PORT}/`).catch(() => null);
      if (probe && probe.ok) {
        console.log(`reusing existing publisher origin on http://127.0.0.1:${ORIGIN_PORT}`);
      } else {
        console.error(`port :${ORIGIN_PORT} is bound but not responding as a publisher origin`);
        process.exit(1);
      }
    } else {
      console.error(`failed to start publisher origin on :${ORIGIN_PORT}: ${err}`);
      process.exit(1);
    }
  }

  try {
    await preflight();
    console.log("pre-flight OK (worker + Tinybird reachable)");
    console.log("---");

    for (const scenario of scenarios) {
      const status = await hitWorker(scenario);
      console.log(`${scenario.name}`);
      console.log(`     HTTP ${status}`);
      if (scenario.acceptStatus.length > 0) {
        const ok = scenario.acceptStatus.includes(status);
        console.log(`  ${ok ? "✓" : "✗"} status: expected ${JSON.stringify(scenario.acceptStatus)}, got ${status}`);
        if (!ok) fail();
      }
    }
    console.log("---");

    console.log(`waiting for ${scenarios.length} rows in Tinybird…`);
    const rows = await tb.waitForRows(MERCHANT_SYSTEM_URN!, PATH_PREFIX, scenarios.length);
    console.log(`got ${rows.length} rows`);
    console.log("---");

    for (const scenario of scenarios) {
      const row = rows.find((r) => r.path === scenario.path);
      console.log(scenario.name);
      if (!row) {
        fail(`no row found for path ${scenario.path}`);
        continue;
      }
      const e = scenario.expected;
      expect("source_cdn", row.source_cdn, e.source_cdn);
      expect("client_ip", row.client_ip, e.client_ip);
      expect("has_token", row.has_token, e.has_token);
      expect("token_outcome", row.token_outcome, e.token_outcome);
      expect("final_action", row.final_action, e.final_action);
      expect("enforcement_mode", row.enforcement_mode, e.enforcement_mode);
    }
    console.log("---");

    const quarantined = await quarantineCount();
    expect("quarantine empty", quarantined, 0);
    console.log("---");

    if (count() > 0) {
      console.error(`FAIL — ${count()} assertion(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log("PASS — analytics pipeline green (5 scenarios)");
  } finally {
    if (origin) await origin.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
