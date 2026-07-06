/**
 * Prod-safe analytics smoke probe.
 *
 * Confirms a DEPLOYED Worker's analytics actually PERSIST to Tinybird — the gap
 * `enforcement.test.ts` doesn't cover (it only asserts HTTP behavior) and that
 * the analytics e2e (`cloudflare-e2e.ts`) only covers locally because it needs
 * `ALLOW_TEST_OVERRIDES`.
 *
 * Differences that make this safe to point at production:
 *   - Uses the Worker's REAL config — sends NO `X-Test-*` headers, so the target
 *     does NOT need `ALLOW_TEST_OVERRIDES` enabled.
 *   - Only exercises outcomes reachable in the deployed (OBSERVE) config:
 *       no token        → token_outcome=absent,   final_action=allow
 *       malformed token → token_outcome=malformed, final_action=block
 *   - Tags every request with a unique path prefix so its rows are identifiable
 *     and never confused with real traffic.
 *   - Honors the analytics toggle: ANALYTICS_EXPECTED=true asserts rows land;
 *     ANALYTICS_EXPECTED=false asserts NONE land (verifies analytics-off).
 *
 * Config: pick the environment with TEST_ENV (default local-cloudflare). Worker
 * URL, Tinybird host, and merchant URN are read from tests/e2e/config.ts — the
 * same source enforcement.test.ts uses. TB_ADMIN_TOKEN is a secret and stays an
 * env var. Any of WORKER_URL / TB_URL / MERCHANT_SYSTEM_URN / ANALYTICS_EXPECTED
 * still override the resolved values.
 *
 * Prod example:
 *   cd ../supertab-connect/tinybird && set -a; . ./.env.prod; set +a
 *   TEST_ENV=production-cloudflare TB_ADMIN_TOKEN="$TB_TOKEN" \
 *     npx tsx tests/e2e/analytics-smoke.ts
 */

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
const ANALYTICS_EXPECTED = (process.env.ANALYTICS_EXPECTED ?? "true") !== "false";

if (!TB_ADMIN_TOKEN) {
  console.error("Set TB_ADMIN_TOKEN (a Tinybird token with read access to the target workspace).");
  process.exit(1);
}
if (!MERCHANT_SYSTEM_URN) {
  console.error("Set MERCHANT_SYSTEM_URN (the merchant system behind the Worker's MERCHANT_API_KEY).");
  process.exit(1);
}

const RUN_ID = Date.now().toString(36);
const PATH_PREFIX = `/analytics-smoke-${RUN_ID}`;

interface Scenario {
  name: string;
  path: string;
  headers: Record<string, string>;
  expected: { has_token: boolean; token_outcome: string; final_action: string; enforcement_mode: string };
}

// Only outcomes reachable WITHOUT test overrides on a deployed OBSERVE worker.
const scenarios: Scenario[] = [
  {
    name: "no token → allow / absent",
    path: `${PATH_PREFIX}/no-token`,
    headers: { "User-Agent": "analytics-smoke" },
    expected: { has_token: false, token_outcome: "absent", final_action: "allow", enforcement_mode: "observe" },
  },
  {
    name: "malformed token → block / malformed",
    path: `${PATH_PREFIX}/bad-token`,
    headers: { "User-Agent": "analytics-smoke", Authorization: "License invalid.token.here" },
    expected: { has_token: true, token_outcome: "malformed", final_action: "block", enforcement_mode: "observe" },
  },
];

const tb = createTinybirdClient(TB_URL, TB_ADMIN_TOKEN!);
const { expect, fail, count } = createExpect();

async function hitWorker(s: Scenario): Promise<void> {
  const res = await fetch(`${WORKER_URL}${s.path}`, { method: "GET", headers: s.headers, redirect: "manual" });
  await res.text().catch(() => "");
}

async function main(): Promise<void> {
  console.log(`env=${TEST_ENV}`);
  console.log(`run_id=${RUN_ID}`);
  console.log(`worker=${WORKER_URL}`);
  console.log(`tinybird=${TB_URL}`);
  console.log(`merchant_system_urn=${MERCHANT_SYSTEM_URN}`);
  console.log(`path_prefix=${PATH_PREFIX}`);
  console.log(`analytics_expected=${ANALYTICS_EXPECTED}`);
  console.log("---");

  // Preflight: worker reachable. Use a path OUTSIDE PATH_PREFIX so it doesn't
  // count toward this run's tagged rows.
  const pf = await fetch(`${WORKER_URL}/__analytics-smoke-preflight`, {
    headers: { "User-Agent": "analytics-smoke-preflight" },
    redirect: "manual",
  }).catch((e) => { console.error(`Pre-flight failed: cannot reach worker at ${WORKER_URL}: ${e}`); process.exit(1); });
  console.log(`worker reachable (preflight status ${(pf as Response).status})`);

  for (const s of scenarios) {
    await hitWorker(s);
    console.log(`sent: ${s.name}  (${s.path})`);
  }
  console.log("---");

  if (ANALYTICS_EXPECTED) {
    // Poll until both rows show up (relay buffers ~0.5s + ingestion latency).
    const rows = await tb.waitForRows(MERCHANT_SYSTEM_URN!, PATH_PREFIX, scenarios.length);
    console.log(`got ${rows.length}/${scenarios.length} rows in Tinybird`);
    for (const s of scenarios) {
      const row = rows.find((r) => r.path === s.path);
      console.log(s.name);
      if (!row) { fail(`no row landed for ${s.path}`); continue; }
      expect("has_token", row.has_token, s.expected.has_token);
      expect("token_outcome", row.token_outcome, s.expected.token_outcome);
      expect("final_action", row.final_action, s.expected.final_action);
      expect("enforcement_mode", row.enforcement_mode, s.expected.enforcement_mode);
    }
  } else {
    // Analytics off: give it a window, then assert NOTHING landed.
    await new Promise((r) => setTimeout(r, 5_000));
    const rows = await tb.fetchRows(MERCHANT_SYSTEM_URN!, PATH_PREFIX);
    console.log(`analytics-off check: ${rows.length} rows landed (expect 0)`);
    if (rows.length !== 0) { fail(`rows landed while analytics disabled:\n${JSON.stringify(rows, null, 2)}`); }
    else console.log("  ✓ no rows landed");
  }

  console.log("---");
  if (count() > 0) { console.log(`FAIL — ${count()} assertion(s) failed`); process.exit(1); }
  console.log(`PASS — analytics ${ANALYTICS_EXPECTED ? "rows landed as expected" : "correctly produced no rows"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
