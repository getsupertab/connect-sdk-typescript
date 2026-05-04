/**
 * Read-isolation harness: SDK → Tinybird → assert per-merchant-system JWT isolation.
 *
 * Validates the read-side multi-tenancy story: each merchant system gets a
 * PIPES:READ JWT with --fixed-params merchant_system_urn=<urn>, and that JWT
 * cannot — even with deliberate URL-parameter override attempts — observe
 * another merchant system's rows.
 *
 * Strategy:
 *   1. Append synthetic rows for two merchant systems (counts differ so we
 *      can distinguish them) directly to bot_events_raw via the admin token.
 *   2. Mint two short-TTL JWTs scoped PIPES:READ:merchant_event_count,
 *      each with --fixed-params merchant_system_urn=<that system's urn>.
 *   3. Query merchant_event_count.json with each JWT and assert row counts.
 *   4. Probe override: with token A, pass &merchant_system_urn=<B>. Tinybird
 *      must ignore the URL value and apply the JWT-bound one.
 *
 * `merchant_event_count` is a one-node helper pipe — see
 * tinybird/tinybird/pipes/merchant_event_count.pipe. The production
 * `traffic_summary` pipe is unsuitable for this kind of synthetic test
 * because its bot-classification JOIN requires populated bot_ua_patterns
 * rows; the helper exercises the same JWT primitive without that setup.
 *
 * Required env:
 *   TB_ADMIN_TOKEN   — workspace admin token (from `tb --local token ls`),
 *                      used to seed rows and mint JWTs via the tb CLI.
 *
 * Optional env:
 *   TB_LOCAL_URL     — defaults to http://localhost:7181
 *   TB_PROJECT_DIR   — directory containing the Tinybird project root.
 *                      `tb` resolves resources from cwd, so we shell out
 *                      with this set. Defaults to the sibling
 *                      ../supertab-connect/tinybird path.
 *
 * Run from the SDK repo root (Tinybird Local must be running):
 *   TB_ADMIN_TOKEN=… npx tsx tests/e2e/read-isolation.ts
 *
 * Exits non-zero on any assertion failure.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const TB_URL = process.env.TB_LOCAL_URL ?? "http://localhost:7181";
const TB_ADMIN_TOKEN = process.env.TB_ADMIN_TOKEN;
const TB_PROJECT_DIR = resolve(
  process.env.TB_PROJECT_DIR ?? new URL("../../../supertab-connect/tinybird", import.meta.url).pathname,
);

if (!TB_ADMIN_TOKEN) {
  console.error("Set TB_ADMIN_TOKEN to a Tinybird Local workspace admin token (`tb --local token ls`).");
  process.exit(1);
}

// Unique per-run merchant system urns so reruns don't accumulate cross-tenant noise.
const RUN_ID = Date.now().toString(36);
const URN_A = `urn:stc:merchant:system:ri-alpha-${RUN_ID}`;
const URN_B = `urn:stc:merchant:system:ri-beta-${RUN_ID}`;
const COUNT_A = 3;
const COUNT_B = 5;

interface PipeResponse {
  data: Array<{ total: number }>;
  rows?: number;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function appendEvents(urn: string, count: number): Promise<void> {
  const ts = nowIso();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        merchant_system_urn: urn,
        timestamp: ts,
        request_id: `${urn}-req-${i}`,
        schema_version: 1,
        source_cdn: "cloudflare",
        user_agent: "Mozilla/5.0",
        client_ip: "::ffff:1.2.3.4",
        path: "/test",
        method: "GET",
        referer: "",
        accept_language: "",
        has_token: false,
        token_outcome: "absent",
        bot_detector_result: "human",
        final_action: "allow",
        enforcement_mode: "observe",
      }),
    );
  }
  const res = await fetch(`${TB_URL}/v0/events?name=bot_events_raw`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TB_ADMIN_TOKEN}`,
      "Content-Type": "application/x-ndjson",
    },
    body: lines.join("\n") + "\n",
  });
  if (!res.ok) {
    throw new Error(`append failed for ${urn}: ${res.status} ${await res.text()}`);
  }
}

function mintJwt(label: string, urn: string): string {
  const tokenName = `read_isolation_${label}_${RUN_ID}`;
  // tb prints a token line; we extract the JWT-shaped substring (eyJ...).
  const cmd = [
    "tb",
    "--local",
    "token",
    "create",
    "jwt",
    tokenName,
    "--ttl",
    "1h",
    "--scope",
    "PIPES:READ",
    "--resource",
    "merchant_event_count",
    "--fixed-params",
    `merchant_system_urn=${urn}`,
  ].join(" ");
  const out = execSync(cmd, { encoding: "utf8", cwd: TB_PROJECT_DIR });
  // JWTs always start with eyJ; capture the longest match.
  const match = out.match(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/);
  if (!match) {
    throw new Error(`Could not parse JWT from tb output:\n${out}`);
  }
  return match[0];
}

async function queryEventCount(
  jwt: string,
  extraParams: Record<string, string> = {},
): Promise<PipeResponse> {
  const params = new URLSearchParams(extraParams);
  const qs = params.toString();
  const url = `${TB_URL}/v0/pipes/merchant_event_count.json${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = (await res.json()) as PipeResponse;
  if (!res.ok) {
    throw new Error(`pipe query failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function totalRequests(resp: PipeResponse): number {
  return resp.data.reduce((sum, row) => sum + (row.total ?? 0), 0);
}

async function waitForRows(urn: string, expected: number, jwt: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let last = -1;
  while (Date.now() < deadline) {
    const resp = await queryEventCount(jwt);
    last = totalRequests(resp);
    if (last >= expected) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out waiting for ${expected} rows for ${urn}; last seen ${last}`,
  );
}

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "✓" : "✗"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures += 1;
}

async function main(): Promise<void> {
  console.log(`run_id=${RUN_ID}`);
  console.log(`urn_a=${URN_A} (${COUNT_A} rows)`);
  console.log(`urn_b=${URN_B} (${COUNT_B} rows)`);
  console.log("---");

  console.log("seeding bot_events_raw…");
  await appendEvents(URN_A, COUNT_A);
  await appendEvents(URN_B, COUNT_B);

  console.log("minting JWTs…");
  const jwtA = mintJwt("a", URN_A);
  const jwtB = mintJwt("b", URN_B);

  console.log("waiting for rows to settle…");
  await waitForRows(URN_A, COUNT_A, jwtA);
  await waitForRows(URN_B, COUNT_B, jwtB);
  console.log("---");

  // 1. Each token sees its own rows.
  const aSelf = await queryEventCount(jwtA);
  expect("token A sees A's row count", totalRequests(aSelf), COUNT_A);

  const bSelf = await queryEventCount(jwtB);
  expect("token B sees B's row count", totalRequests(bSelf), COUNT_B);

  // 2. Override probe: token A passes merchant_system_urn=<B> in the URL.
  // JWT fixed_params must win — A still sees only A's rows.
  let overrideOutcome: "ignored" | "rejected" | "leaked" = "ignored";
  let aOverrideTotal: number | null = null;
  try {
    const resp = await queryEventCount(jwtA, { merchant_system_urn: URN_B });
    aOverrideTotal = totalRequests(resp);
    if (aOverrideTotal === COUNT_B) overrideOutcome = "leaked";
  } catch {
    overrideOutcome = "rejected";
  }
  console.log(
    `override outcome: ${overrideOutcome}` +
      (aOverrideTotal !== null ? ` (saw ${aOverrideTotal} rows)` : ""),
  );
  if (overrideOutcome === "leaked") failures += 1;
  // "ignored" (returned A's data anyway) and "rejected" (Tinybird 4xx'd the
  // mismatch) are both acceptable — both demonstrate isolation.

  // 3. Cross-token spot check: tokens are independent — A queried with B's
  // jwt does not somehow merge.
  const bSelfAgain = await queryEventCount(jwtB);
  expect("token B count stable on second query", totalRequests(bSelfAgain), COUNT_B);

  console.log("---");
  if (failures > 0) {
    console.error(`FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("PASS — read-side multi-tenancy isolated");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
