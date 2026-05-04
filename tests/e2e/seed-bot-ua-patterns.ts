/**
 * Seed bot_ua_patterns from the hand-curated NDJSON fixture.
 *
 * Reads tinybird/tinybird/seed_bot_ua_patterns.ndjson, stamps each row with
 * updated_at=now(), POSTs to the local Tinybird Events API for the
 * bot_ua_patterns datasource. Idempotent — the underlying engine is
 * ReplacingMergeTree(updated_at) keyed on pattern_id, so re-running just
 * bumps updated_at and the latest row wins on read (with FINAL).
 *
 * Required env:
 *   TB_ADMIN_TOKEN   — workspace admin token from `tb --local token ls`.
 *
 * Optional env:
 *   TB_LOCAL_URL     — defaults to http://localhost:7181
 *   SEED_FILE        — defaults to the sibling
 *                      ../supertab-connect/tinybird/tinybird/seed_bot_ua_patterns.ndjson
 *
 * Run from the SDK repo root:
 *   TB_ADMIN_TOKEN=$(cd ../supertab-connect/tinybird && tb --local token ls | awk '/^name: workspace admin token/{getline; print $2}') \
 *     npx tsx tests/e2e/seed-bot-ua-patterns.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TB_URL = process.env.TB_LOCAL_URL ?? "http://localhost:7181";
const TB_ADMIN_TOKEN = process.env.TB_ADMIN_TOKEN;
const SEED_FILE = resolve(
  process.env.SEED_FILE ??
    new URL(
      "../../../supertab-connect/tinybird/tinybird/seed_bot_ua_patterns.ndjson",
      import.meta.url,
    ).pathname,
);

if (!TB_ADMIN_TOKEN) {
  console.error(
    "Set TB_ADMIN_TOKEN to a Tinybird Local workspace admin token (`tb --local token ls`).",
  );
  process.exit(1);
}

interface SeedRow {
  pattern_id: number;
  pattern: string;
  match_type: string;
  bot_label: string;
  bot_category: string;
  is_active: boolean;
}

interface StampedRow extends SeedRow {
  updated_at: string;
}

function loadSeed(path: string): SeedRow[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as SeedRow;
    } catch (err) {
      throw new Error(`Failed to parse line ${i + 1} of ${path}: ${err}`);
    }
  });
}

function stamp(rows: SeedRow[]): StampedRow[] {
  // ClickHouse DateTime64(3) accepts "YYYY-MM-DD HH:MM:SS.fff".
  const now = new Date();
  const updated_at =
    now.toISOString().replace("T", " ").replace("Z", "");
  return rows.map((r) => ({ ...r, updated_at }));
}

async function postEvents(rows: StampedRow[]): Promise<void> {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const res = await fetch(`${TB_URL}/v0/events?name=bot_ua_patterns`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TB_ADMIN_TOKEN}`,
      "Content-Type": "application/x-ndjson",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`POST failed: ${res.status} ${await res.text()}`);
  }
}

interface SqlResponse {
  data: Array<Record<string, unknown>>;
  error?: string;
}

async function querySql(query: string): Promise<SqlResponse> {
  const url = `${TB_URL}/v0/sql?q=${encodeURIComponent(query + " FORMAT JSON")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TB_ADMIN_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`sql query failed: ${res.status} ${text}`);
  return JSON.parse(text) as SqlResponse;
}

async function postStateCount(): Promise<number> {
  // Poll briefly — Tinybird's Events API is async, the row may not be
  // queryable the instant the POST returns 202.
  const deadline = Date.now() + 5000;
  let last = 0;
  while (Date.now() < deadline) {
    const resp = await querySql(
      "SELECT count() AS c FROM bot_ua_patterns FINAL WHERE is_active",
    );
    last = Number((resp.data?.[0] as { c?: number })?.c ?? 0);
    if (last > 0) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

async function main(): Promise<void> {
  console.log(`seed_file=${SEED_FILE}`);
  console.log(`tinybird=${TB_URL}`);
  console.log("---");

  const rows = loadSeed(SEED_FILE);
  console.log(`parsed ${rows.length} rows from NDJSON`);

  const stamped = stamp(rows);
  await postEvents(stamped);
  console.log(`POST ok: ${stamped.length} rows sent to bot_ua_patterns`);

  const count = await postStateCount();
  console.log(
    `post-state: SELECT count() FROM bot_ua_patterns FINAL WHERE is_active = ${count}`,
  );

  if (count !== rows.length) {
    console.error(
      `WARN — count (${count}) does not match seed length (${rows.length}). ` +
        "If reseeding, this can mean a previous seed had different rows; " +
        "check for stale pattern_ids removed from the NDJSON.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("PASS — bot_ua_patterns seeded");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
