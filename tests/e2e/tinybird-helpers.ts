/**
 * Shared helpers for the analytics e2e checks (`cloudflare-e2e.ts`,
 * `analytics-smoke.ts`): query Tinybird, poll for a run's tagged rows, and a
 * tiny ✓/✗ assertion tracker. Keeps both scripts from re-implementing the same
 * SQL plumbing.
 */

/** A bot_events_raw row (superset of what either harness asserts on). */
export interface SqlRow {
  request_id?: string;
  source_cdn?: string;
  client_ip?: string;
  path: string;
  has_token: boolean | number;
  token_outcome: string;
  final_action: string;
  enforcement_mode: string;
}

interface SqlResponse {
  data: SqlRow[];
  rows?: number;
  error?: string;
}

export interface TinybirdClient {
  /** Run a raw SQL query against the workspace (appends FORMAT JSON). */
  querySql(query: string): Promise<SqlResponse>;
  /** All bot_events_raw rows for a merchant tagged with `${pathPrefix}/...`. */
  fetchRows(merchantSystemUrn: string, pathPrefix: string): Promise<SqlRow[]>;
  /** Poll fetchRows until `expected` rows appear or the timeout elapses. Returns
   *  whatever it last saw (does NOT throw on shortfall — caller decides). */
  waitForRows(
    merchantSystemUrn: string,
    pathPrefix: string,
    expected: number,
    timeoutMs?: number,
  ): Promise<SqlRow[]>;
}

/** Build a Tinybird client bound to a workspace host + read token. */
export function createTinybirdClient(tbUrl: string, adminToken: string): TinybirdClient {
  async function querySql(query: string): Promise<SqlResponse> {
    const url = `${tbUrl}/v0/sql?q=${encodeURIComponent(query + " FORMAT JSON")}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`sql query failed: ${res.status} ${text}`);
    try {
      return JSON.parse(text) as SqlResponse;
    } catch {
      throw new Error(`sql query returned non-JSON: ${text}`);
    }
  }

  async function fetchRows(merchantSystemUrn: string, pathPrefix: string): Promise<SqlRow[]> {
    const q = `
      SELECT request_id, source_cdn, client_ip, path,
             has_token, token_outcome, final_action, enforcement_mode
      FROM bot_events_raw
      WHERE merchant_system_urn = '${merchantSystemUrn}'
        AND path LIKE '${pathPrefix}/%'
      ORDER BY timestamp ASC`;
    return (await querySql(q)).data ?? [];
  }

  async function waitForRows(
    merchantSystemUrn: string,
    pathPrefix: string,
    expected: number,
    timeoutMs = 20_000,
  ): Promise<SqlRow[]> {
    const deadline = Date.now() + timeoutMs;
    let last: SqlRow[] = [];
    while (Date.now() < deadline) {
      last = await fetchRows(merchantSystemUrn, pathPrefix);
      if (last.length >= expected) return last;
      await new Promise((r) => setTimeout(r, 300));
    }
    return last;
  }

  return { querySql, fetchRows, waitForRows };
}

/** Tiny assertion tracker — prints ✓/✗ lines and counts failures. */
export function createExpect() {
  let failures = 0;
  // ClickHouse JSON returns booleans as 0/1; normalize so true === 1.
  const norm = (v: unknown) => (typeof v === "number" && (v === 0 || v === 1) ? Boolean(v) : v);

  function expect(label: string, actual: unknown, expected: unknown): void {
    const pass = JSON.stringify(norm(actual)) === JSON.stringify(norm(expected));
    console.log(`  ${pass ? "✓" : "✗"} ${label}: expected ${JSON.stringify(norm(expected))}, got ${JSON.stringify(norm(actual))}`);
    if (!pass) failures += 1;
  }

  /** Record a failure that isn't a simple equality check (e.g. a missing row). */
  function fail(message?: string): void {
    if (message) console.log(`  ✗ ${message}`);
    failures += 1;
  }

  return { expect, fail, count: () => failures };
}
