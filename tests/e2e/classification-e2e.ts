/**
 * Classification E2E harness.
 *
 * Validates Phase 3: bot_ua_patterns is seeded, traffic_summary's join-time
 * classification resolves canonical UAs to the right bot_label, and the
 * argMin(_, pattern_id) ordering picks specific patterns over generic
 * catch-alls.
 *
 * Three blocks:
 *   (a) Seed sanity — count(bot_ua_patterns FINAL WHERE is_active) matches
 *       the NDJSON fixture line count.
 *   (b) Canonical labeling — for each (UA, expected_label, expected_category):
 *         - insert a synthetic row into bot_events_raw under a unique
 *           per-case merchant_id
 *         - assert traffic_summary returns expected_label (the merchant path)
 *         - assert direct argMin(bot_category, pattern_id) on bot_ua_patterns
 *           returns expected_category (bypass the pipe — keeps traffic_summary
 *           free of test-only fields)
 *   (c) Disambiguation — a UA that matches both a specific pattern (e.g.
 *       GPTBot, id=1) and a generic catch-all (e.g. "bot", id=1002) must
 *       resolve to the specific one. This is the band-convention guarantee.
 *
 * Required env:
 *   TB_ADMIN_TOKEN   — workspace admin token (`tb --local token ls`).
 *
 * Optional env:
 *   TB_LOCAL_URL     — defaults to http://localhost:7181
 *   SEED_FILE        — same default as seed-bot-ua-patterns.ts
 *
 * Prereqs:
 *   - Tinybird Local: `cd ../supertab-connect/tinybird && tb dev`
 *   - bot_ua_patterns seeded: `npx tsx tests/e2e/seed-bot-ua-patterns.ts`
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
  console.error("Set TB_ADMIN_TOKEN to a Tinybird Local workspace admin token (`tb --local token ls`).");
  process.exit(1);
}

const RUN_ID = Date.now().toString(36);

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

async function queryPipe(
  name: string,
  params: Record<string, string>,
): Promise<SqlResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${TB_URL}/v0/pipes/${name}.json?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TB_ADMIN_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`pipe ${name} failed: ${res.status} ${text}`);
  return JSON.parse(text) as SqlResponse;
}

function escapeSqlString(s: string): string {
  // ClickHouse string-literal escaping — backslash and single-quote.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function clickhouseDatetime(d: Date): string {
  // ClickHouse DateTime64(3) parameter literal: YYYY-MM-DD HH:MM:SS.fff
  return d.toISOString().replace("T", " ").replace("Z", "");
}

interface WinningPattern {
  pattern_id: number | null;
  bot_label: string | null;
  bot_category: string | null;
}

/**
 * Replicate the JOIN+argMin logic from traffic_summary.classified_events
 * for a single UA, against the patterns table. Used to assert category
 * without modifying the production pipe — and to spot ordering bugs that
 * a label-only check could miss.
 */
async function winningPattern(ua: string): Promise<WinningPattern> {
  const escaped = escapeSqlString(ua);
  // Note: the pipe also has a `match_type='regex'` branch using match(haystack, needle).
  // We omit it here because ClickHouse rejects match() when haystack is a
  // constant and needle is a column ("non-constant needles in constant haystack").
  // The seed has zero regex patterns so this is a no-op for now; if regex
  // patterns are added later, this query needs reshaping (e.g. arrayExists).
  const q = `
    SELECT
      min(pattern_id)               AS winning_pattern_id,
      argMin(bot_label, pattern_id) AS bot_label,
      argMin(bot_category, pattern_id) AS bot_category
    FROM bot_ua_patterns FINAL
    WHERE is_active = true
      AND (
        (match_type = 'exact'    AND '${escaped}' = pattern) OR
        (match_type = 'prefix'   AND startsWith('${escaped}', pattern)) OR
        (match_type = 'contains' AND position('${escaped}', pattern) > 0)
      )
  `;
  const resp = await querySql(q);
  const row = (resp.data?.[0] ?? {}) as {
    winning_pattern_id?: number | string;
    bot_label?: string;
    bot_category?: string;
  };
  // min() / argMin() over an empty set return 0 / "" — normalize to null
  // so "no match" is unambiguous in test output.
  const pid = Number(row.winning_pattern_id ?? 0);
  if (!pid) return { pattern_id: null, bot_label: null, bot_category: null };
  return {
    pattern_id: pid,
    bot_label: row.bot_label || null,
    bot_category: row.bot_category || null,
  };
}

async function insertEvent(
  merchantId: string,
  userAgent: string,
  path: string,
): Promise<void> {
  const ts = clickhouseDatetime(new Date());
  const row = {
    merchant_id: merchantId,
    timestamp: ts,
    request_id: `${merchantId}-${Math.random().toString(36).slice(2, 10)}`,
    schema_version: 1,
    source_cdn: "cloudflare",
    user_agent: userAgent,
    client_ip: "::ffff:1.2.3.4",
    path,
    method: "GET",
    referer: "",
    accept_language: "",
    has_token: false,
    token_outcome: "absent",
    bot_detector_result: "unknown",
    final_action: "observe",
    enforcement_mode: "observe",
  };
  const res = await fetch(`${TB_URL}/v0/events?name=bot_events_raw`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TB_ADMIN_TOKEN}`,
      "Content-Type": "application/x-ndjson",
    },
    body: JSON.stringify(row) + "\n",
  });
  if (!res.ok) {
    throw new Error(`insertEvent failed: ${res.status} ${await res.text()}`);
  }
}

interface SummaryRow {
  hour: string;
  bot_label: string;
  final_action: string;
  total_requests: number | string;
}

async function trafficSummaryLabel(merchantId: string): Promise<string | null> {
  // Wide window so we don't miss the freshly-inserted row regardless of
  // clock skew between this process and Tinybird.
  const fromTs = clickhouseDatetime(new Date(Date.now() - 5 * 60_000));
  const toTs = clickhouseDatetime(new Date(Date.now() + 5 * 60_000));

  const deadline = Date.now() + 8000;
  let last: SummaryRow[] = [];
  while (Date.now() < deadline) {
    const resp = await queryPipe("traffic_summary", {
      merchant_id: merchantId,
      from_ts: fromTs,
      to_ts: toTs,
    });
    last = (resp.data ?? []) as unknown as SummaryRow[];
    if (last.length > 0) {
      // We insert exactly one event per merchant_id; one row out is the
      // happy path. If the pipe ever returns multiple, surface a clear
      // failure rather than silently picking one.
      if (last.length > 1) {
        throw new Error(
          `traffic_summary returned ${last.length} rows for ${merchantId}; ` +
            `expected 1: ${JSON.stringify(last)}`,
        );
      }
      return last[0].bot_label;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

interface CanonicalCase {
  name: string;
  ua: string;
  expected_label: string;
  expected_category: string | null;
}

const canonical: CanonicalCase[] = [
  {
    name: "GPTBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.0; +https://openai.com/gptbot",
    expected_label: "GPTBot",
    expected_category: "ai_training",
  },
  {
    name: "ChatGPT-User",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    expected_label: "ChatGPT-User",
    expected_category: "ai_assistant",
  },
  {
    name: "ClaudeBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    expected_label: "ClaudeBot",
    expected_category: "ai_training",
  },
  {
    name: "Claude-User",
    ua: "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
    expected_label: "Claude-User",
    expected_category: "ai_assistant",
  },
  {
    name: "PerplexityBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot",
    expected_label: "PerplexityBot",
    expected_category: "ai_search",
  },
  {
    name: "Googlebot",
    ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    expected_label: "Googlebot",
    expected_category: "search_indexer",
  },
  {
    name: "Bingbot",
    ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    expected_label: "Bingbot",
    expected_category: "search_indexer",
  },
  {
    name: "facebookexternalhit",
    ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    expected_label: "facebookexternalhit",
    expected_category: "page_preview",
  },
  {
    name: "AhrefsBot",
    ua: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    expected_label: "AhrefsBot",
    expected_category: "seo_tool",
  },
  {
    name: "CCBot",
    ua: "Mozilla/5.0 (compatible; CCBot/2.0; +https://commoncrawl.org/faq/)",
    expected_label: "CCBot",
    expected_category: "ai_training",
  },
  {
    name: "Bytespider",
    ua: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
    expected_label: "Bytespider",
    expected_category: "ai_training",
  },
  {
    name: "Unknown human Safari (unclassified)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15",
    expected_label: "unclassified",
    expected_category: null,
  },
];

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${pass ? "✓" : "✗"} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!pass) failures += 1;
}

function loadSeedRowCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
}

async function blockA_seedSanity(): Promise<void> {
  console.log("(a) seed sanity");
  const expected = loadSeedRowCount(SEED_FILE);
  const resp = await querySql("SELECT count() AS c FROM bot_ua_patterns FINAL WHERE is_active");
  const actual = Number((resp.data?.[0] as { c?: number })?.c ?? 0);
  expect(`bot_ua_patterns FINAL WHERE is_active count == NDJSON line count`, actual, expected);
}

async function blockB_canonicalLabeling(): Promise<void> {
  console.log("(b) canonical UA labeling");
  for (const [i, c] of canonical.entries()) {
    console.log(`  case: ${c.name}`);
    const merchantId = `cls_${RUN_ID}_${String(i).padStart(2, "0")}`;
    await insertEvent(merchantId, c.ua, `/cls/${RUN_ID}/${i}`);

    const labelFromPipe = await trafficSummaryLabel(merchantId);
    expect(`    traffic_summary.bot_label`, labelFromPipe, c.expected_label);

    const winning = await winningPattern(c.ua);
    expect(`    winningPattern.bot_category`, winning.bot_category, c.expected_category);
  }
}

async function blockC_disambiguation(): Promise<void> {
  console.log("(c) disambiguation (band convention)");
  // GPTBot UA contains both "GPTBot" (id=1, ai_training) and "Bot"/"bot"
  // (id=1003/1002, scraper). argMin(_, pattern_id) must pick id=1.
  const ua = "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)";
  const winning = await winningPattern(ua);
  expect("  winning pattern_id is GPTBot's (id=1)", winning.pattern_id, 1);
  expect("  winning bot_label", winning.bot_label, "GPTBot");
  expect("  winning bot_category", winning.bot_category, "ai_training");

  // Belt-and-braces: also assert via the real pipe (one merchant, one row).
  const merchantId = `cls_${RUN_ID}_disambig`;
  await insertEvent(merchantId, ua, `/cls/${RUN_ID}/disambig`);
  const labelFromPipe = await trafficSummaryLabel(merchantId);
  expect("  traffic_summary returns specific (not generic) label", labelFromPipe, "GPTBot");
}

async function main(): Promise<void> {
  console.log(`run_id=${RUN_ID}`);
  console.log(`tinybird=${TB_URL}`);
  console.log(`seed_file=${SEED_FILE}`);
  console.log("---");

  await blockA_seedSanity();
  console.log("---");
  await blockB_canonicalLabeling();
  console.log("---");
  await blockC_disambiguation();
  console.log("---");

  if (failures > 0) {
    console.error(`FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("PASS — classification pipeline green");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
