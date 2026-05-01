/**
 * Cloudflare analytics-pipeline E2E harness.
 *
 * Runs the SDK inside `wrangler dev` (workerd, the actual production
 * runtime) against Tinybird Local, walks all six emission branches in
 * `handleRequest`, and asserts that each one lands a row in
 * `bot_events_raw` with the right `source_cdn` / `client_ip` /
 * `bot_detector_result` / `token_outcome` / `final_action` /
 * `enforcement_mode`.
 *
 * Different concern from `tests/e2e/enforcement.test.ts`:
 *   - enforcement.test.ts asserts on **HTTP responses** (status, headers,
 *     bodies) — Worker behavior.
 *   - this file asserts on **Tinybird rows** — analytics pipeline integrity.
 * Both run against the same wrangler dev instance.
 *
 * Replaces the earlier `scratch/local-emit.ts` (Node-only, manual eyeball)
 * + `scratch/cloudflare-e2e.ts` (workerd, only 3 of 6 branches). One file,
 * six scenarios, self-asserting, in the production runtime.
 *
 * Required env:
 *   TB_ADMIN_TOKEN   — workspace admin token from `tb --local token ls`,
 *                      used to query bot_events_raw directly.
 *
 * Optional env:
 *   TB_LOCAL_URL     — defaults to http://localhost:7181
 *   WORKER_URL       — defaults to http://127.0.0.1:8788
 *   MERCHANT_ID      — defaults to demos/cloudflare/.dev.vars MERCHANT_ID;
 *                      override if you've changed that.
 *   ORIGIN_PORT      — defaults to 8789
 *
 * Prerequisites:
 *   - Tinybird Local: `cd ../supertab-connect/tinybird && tb dev`
 *   - Worker:         `cd demos/cloudflare && npx wrangler dev --port 8788 --ip 127.0.0.1`
 *     (.dev.vars must contain ALLOW_TEST_OVERRIDES=true so the worker
 *      honors X-Test-Enforcement / X-Test-Bot-Detection headers)
 *
 * Run from the SDK repo root:
 *   TB_ADMIN_TOKEN=$(cd ../supertab-connect/tinybird && tb --local token ls | awk '/^name: workspace admin token/{getline; print $2}') \
 *     npx tsx tests/e2e/cloudflare-e2e.ts
 */

import { startOrigin, OriginHandle } from "../../demos/cloudflare/origin";

const TB_URL = process.env.TB_LOCAL_URL ?? "http://localhost:7181";
const TB_ADMIN_TOKEN = process.env.TB_ADMIN_TOKEN;
const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8788";
const MERCHANT_ID =
  process.env.MERCHANT_ID ?? "merchant:system:ca7cd003-37d0-4401-9be8-a27b5974cc5b";
const ORIGIN_PORT = Number(process.env.ORIGIN_PORT ?? 8789);

if (!TB_ADMIN_TOKEN) {
  console.error("Set TB_ADMIN_TOKEN to a Tinybird Local workspace admin token (`tb --local token ls`).");
  process.exit(1);
}

const RUN_ID = Date.now().toString(36);
const PATH_PREFIX = `/cf-e2e-${RUN_ID}`;

type FinalAction = "allow" | "observe" | "block";
type BotDetectorResult = "human" | "unverified_bot" | "suspicious" | "unknown" | "verified_bot";
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
    bot_detector_result: BotDetectorResult;
    final_action: FinalAction;
    enforcement_mode: EnforcementMode;
  };
}

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HEADLESS_UA =
  "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0";

const scenarios: Scenario[] = [
  {
    name: "1. human + no token + OBSERVE → allow/human",
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
      bot_detector_result: "human",
      final_action: "allow",
      enforcement_mode: "observe",
    },
  },
  {
    name: "2. GPTBot + no token + OBSERVE → observe/unverified_bot",
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
      bot_detector_result: "unverified_bot",
      final_action: "observe",
      enforcement_mode: "observe",
    },
  },
  {
    name: "3. ClaudeBot + no token + ENFORCE → block/unverified_bot",
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
      bot_detector_result: "unverified_bot",
      final_action: "block",
      enforcement_mode: "enforce",
    },
  },
  {
    name: "4. headless browser + no token + OBSERVE → observe/suspicious",
    path: `${PATH_PREFIX}/headless`,
    clientIp: "198.51.100.4",
    enforcement: "observe",
    botDetection: true,
    headers: { "User-Agent": HEADLESS_UA },
    acceptStatus: [200],
    expected: {
      source_cdn: "cloudflare",
      client_ip: "::ffff:198.51.100.4",
      has_token: false,
      token_outcome: "absent",
      bot_detector_result: "suspicious",
      final_action: "observe",
      enforcement_mode: "observe",
    },
  },
  {
    name: "5. GPTBot + no token + DISABLED → allow/unverified_bot",
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
      bot_detector_result: "unverified_bot",
      final_action: "allow",
      enforcement_mode: "disabled",
    },
  },
  {
    name: "6. GPTBot + malformed License + OBSERVE → block/unknown/malformed",
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
      bot_detector_result: "unknown",
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
    console.error("Make sure .dev.vars contains  ALLOW_TEST_OVERRIDES=true");
    process.exit(1);
  }

  const tbRes = await fetch(`${TB_URL}/v0/health`).catch(() => null);
  if (!tbRes || !tbRes.ok) {
    console.error(`Pre-flight failed: Tinybird Local not healthy at ${TB_URL}`);
    console.error("Start it: cd ../supertab-connect/tinybird && tb dev");
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

interface SqlRow {
  request_id: string;
  source_cdn: string;
  client_ip: string;
  path: string;
  has_token: boolean | number;
  token_outcome: string;
  bot_detector_result: string;
  final_action: string;
  enforcement_mode: string;
}

interface SqlResponse { data: SqlRow[]; rows?: number; error?: string; }

async function querySql(query: string): Promise<SqlResponse> {
  const url = `${TB_URL}/v0/sql?q=${encodeURIComponent(query + " FORMAT JSON")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TB_ADMIN_TOKEN}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`sql query failed: ${res.status} ${text}`);
  try { return JSON.parse(text) as SqlResponse; }
  catch { throw new Error(`sql query returned non-JSON: ${text}`); }
}

async function fetchRowsForRun(): Promise<SqlRow[]> {
  const q = `
    SELECT request_id, source_cdn, client_ip, path,
           has_token, token_outcome, bot_detector_result,
           final_action, enforcement_mode
    FROM bot_events_raw
    WHERE merchant_id = '${MERCHANT_ID}'
      AND path LIKE '${PATH_PREFIX}/%'
    ORDER BY timestamp ASC
  `;
  const resp = await querySql(q);
  return resp.data ?? [];
}

async function waitForRows(expected: number, timeoutMs = 15_000): Promise<SqlRow[]> {
  const deadline = Date.now() + timeoutMs;
  let last: SqlRow[] = [];
  while (Date.now() < deadline) {
    last = await fetchRowsForRun();
    if (last.length >= expected) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `timed out waiting for ${expected} rows; last saw ${last.length}` +
      (last.length > 0 ? `:\n${JSON.stringify(last, null, 2)}` : ""),
  );
}

async function quarantineCount(): Promise<number> {
  // _quarantine only materializes when a row fails ingest validation.
  // Its absence is the healthy state — handle the "Datasource not found"
  // error as a count of zero.
  try {
    const resp = await querySql("SELECT count() AS c FROM bot_events_raw_quarantine");
    return Number((resp.data?.[0] as { c?: number })?.c ?? 0);
  } catch (err) {
    if (String(err).includes("Datasource") || String(err).includes("not found")) return 0;
    throw err;
  }
}

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  // ClickHouse JSON returns booleans as 0/1; normalize so true === 1.
  const normalize = (v: unknown) => (typeof v === "number" && (v === 0 || v === 1) ? Boolean(v) : v);
  const a = normalize(actual);
  const e = normalize(expected);
  const pass = JSON.stringify(a) === JSON.stringify(e);
  console.log(`  ${pass ? "✓" : "✗"} ${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  if (!pass) failures += 1;
}

async function main(): Promise<void> {
  console.log(`run_id=${RUN_ID}`);
  console.log(`merchant_id=${MERCHANT_ID}`);
  console.log(`worker=${WORKER_URL}`);
  console.log(`tinybird=${TB_URL}`);
  console.log(`path_prefix=${PATH_PREFIX}`);
  console.log("---");

  // Prefer to own the origin in-process. If something's already bound to
  // ORIGIN_PORT (a manually-started `npx tsx demos/cloudflare/origin.ts`,
  // typically), reuse it — the behavior is identical, we just don't close
  // it on exit.
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

    // Hit the worker for every scenario sequentially so wrangler logs
    // interleave with our output, easier to debug failures.
    for (const scenario of scenarios) {
      const status = await hitWorker(scenario);
      console.log(`${scenario.name}`);
      console.log(`     HTTP ${status}`);
      if (scenario.acceptStatus.length > 0) {
        const ok = scenario.acceptStatus.includes(status);
        console.log(`  ${ok ? "✓" : "✗"} status: expected ${JSON.stringify(scenario.acceptStatus)}, got ${status}`);
        if (!ok) failures += 1;
      }
    }
    console.log("---");

    console.log(`waiting for ${scenarios.length} rows in Tinybird…`);
    const rows = await waitForRows(scenarios.length);
    console.log(`got ${rows.length} rows`);
    console.log("---");

    for (const scenario of scenarios) {
      const row = rows.find((r) => r.path === scenario.path);
      console.log(scenario.name);
      if (!row) {
        console.error(`  ✗ no row found for path ${scenario.path}`);
        failures += 1;
        continue;
      }
      const e = scenario.expected;
      expect("source_cdn", row.source_cdn, e.source_cdn);
      expect("client_ip", row.client_ip, e.client_ip);
      expect("has_token", row.has_token, e.has_token);
      expect("token_outcome", row.token_outcome, e.token_outcome);
      expect("bot_detector_result", row.bot_detector_result, e.bot_detector_result);
      expect("final_action", row.final_action, e.final_action);
      expect("enforcement_mode", row.enforcement_mode, e.enforcement_mode);
    }
    console.log("---");

    const quarantined = await quarantineCount();
    expect("quarantine empty", quarantined, 0);
    console.log("---");

    if (failures > 0) {
      console.error(`FAIL — ${failures} assertion(s) failed`);
      process.exitCode = 1;
      return;
    }
    console.log("PASS — analytics pipeline green (6 scenarios, all 6 emit branches)");
  } finally {
    if (origin) await origin.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
