# Bot Traffic Analytics — State

> Single source of truth for **what's built, where it lives, and how to
> run it**. For the chronological "why" behind specific decisions, see
> `DECISIONS.md`.

---

## Phase status

**Not for release yet.** v2.0.0 SDK changes are too large to ship. Target
is "end-to-end working locally" through Phase 4; release discussion comes
after.

### Phase 1 — Build  ✅

**Goal:** v2.0 SDK + Tinybird schema sketched out and locally verified;
prove read-side multi-tenancy works as designed.

**Shipped:**
- SDK v2.0 breaking changes: `EnforcementMode` rename (SOFT/STRICT → OBSERVE/ENFORCE), three-state `HandlerAction`, `BotDetector` returns `BotVerdict` (5-value), separate `apiKey` + `merchantSystemUrn` config fields, per-request `request_id`/`source_cdn`/`client_ip` plumbing, `AnalyticsTransport` interface with `HttpAnalyticsTransport` + `NoopAnalyticsTransport`.
- Tinybird datasources: `bot_events_raw` (90-day TTL, MergeTree), `bot_ua_patterns` (ReplacingMergeTree).
- Tinybird pipes: `traffic_summary.pipe` (production rollup), `merchant_event_count.pipe` (read-isolation helper).

**Verification:** 40 vitest unit tests pass. `read-isolation.ts` proves
per-URN JWT scoping works and URL-parameter override is silently ignored.

### Phase 2 — Real CDN runtime  ✅

**Goal:** prove the SDK works in a real edge runtime (workerd), not
just Node. The Phase 1 harness validated `buildAnalyticsEvent` + the
transport in Node, but didn't exercise `ctx.waitUntil` firing in
workerd, `cf-connecting-ip` extraction from a real Workers `Request`,
the `source_cdn: 'cloudflare'` path, or whether the SDK even bundles
into a Worker.

**Shipped:**
- `demos/cloudflare/` repurposed as the Phase 2 target. SDK dep linked locally via `file:../..`.
- `cloudflare-e2e.ts` harness — six scenarios covering every SDK emission branch (allow / observe / block × bot-detector states × enforcement modes), driven via `X-Test-Enforcement` / `X-Test-Bot-Detection` per-request headers.

**Verification:** `cloudflare-e2e.ts` passes — 6 scenarios × 7
field-level assertions each + quarantine-empty check, all green.

### Phase 2.5 — Production-like local setup  ✅

**Goal:** issue and validate **real ES256 license tokens** locally so
the token-present SDK path is exercised end-to-end. Phase 2's
three-scenario harness only ran the no-token paths; when enforcement
tests started using real tokens, the original URL-rewrite workaround
broke because token `aud` didn't match the rewritten origin URL.

**Shipped:**
- Demo Worker now mirrors the production two-Worker split (CAP + RSL) in a single local `wrangler dev` fetch handler. `/license.xml` proxies to the local backend; everything else hits `cloudflareHandleRequests`.
- Local `supertab-connect` backend wired in (port 8000) — JWKS, license token issuance, billing event-record path.
- Publisher origin (`origin.ts`, port 8789) consolidated from a previous duplicate. Standalone-runnable; harnesses import its `startOrigin()`.
- New SDK option `cloudflareHandleRequests({ originUrl })` — license verification still uses `request.url` (so token `aud` matches the publisher URL) but ALLOW/OBSERVE pass-through fetches go to `originUrl`. Production deployments using Workers Routes can omit it.
- Port re-alignment: Worker = `:8788` (publisher URL, what tokens are bound to via `aud`), origin = `:8789`, backend = `:8000`, Tinybird = `:7181`.

**Verification:** `enforcement.test.ts > Soft Mode > valid token gets
200` passes against the local backend with real ES256 tokens. `curl
http://127.0.0.1:8788/license.xml` returns RSL XML proxied from the
backend.

### Phase 3 — Classification  ✅

**Goal:** rows arrive with real `bot_label` values, not `unclassified`.

**Shipped:**
- `seed_bot_ua_patterns.ndjson` — 171 hand-curated rows merged from `ai.robots.txt`, Cloudflare's KnownAgents, and per-vendor operator docs. Nine categories (`ai_training`, `ai_assistant`, `ai_search`, `ai_agent`, `search_indexer`, `page_preview`, `archiver`, `seo_tool`, `scraper`) and a band convention on `pattern_id` encoding priority via `argMin` (lower wins; specific patterns sit below generics).
- `seed-bot-ua-patterns.ts` — idempotent NDJSON loader (re-runs bump `updated_at`; `ReplacingMergeTree` collapses on read).
- `classification-e2e.ts` — three blocks: seed sanity (count matches NDJSON line count), 12 canonical UAs end-to-end through the merchant pipe, disambiguation block proving specific patterns win over generics.
- **Two unanticipated Tinybird fixes** (in scope of Phase 3 but beyond the brief):
  1. `bot_ua_patterns.datasource` gained JSONPaths annotations — Tinybird had been treating it as CSV-only and rejecting NDJSON ingest via the Events API.
  2. `traffic_summary.pipe`'s `classified_events` node restructured. The original `LEFT JOIN bot_ua_patterns ON (OR-chain of non-equi predicates)` is rejected by ClickHouse (`Cannot determine join keys`), and the bypass setting is restricted on Tinybird. New shape: a `matched` CTE pre-classifies via `CROSS JOIN + WHERE` keyed on `request_id`, then equi-`LEFT JOIN`. The earlier "works once seeded" claim was wrong — the pipe had simply never been exercised.

**Verification:** `classification-e2e.ts` passes — 1 sanity + 24
canonical-UA assertions + 4 disambig assertions, all green.
Real merchant data (110-row slice from a wrangler session) classifies
end-to-end through the live pipe — GPTBot / ClaudeBot / HeadlessChrome
/ curl / unclassified all visible.

### Post-Phase-3 cleanup  ✅

**Goal:** resolve a naming inconsistency that surfaced during the
Phase 3 audit. The SDK's `merchantId` config field was carrying a
merchant *system* identifier (the analytics rows are per-merchant-system,
not per-merchant), and the demo's value was a half-URN
(`merchant:system:<uuid>`) that exists nowhere else in the system —
backend canonical is the full URN form.

**Shipped:**
- SDK config field `merchantId` → `merchantSystemUrn`. Cloudflare env `MERCHANT_ID` → `MERCHANT_SYSTEM_URN`. JSON wire field `merchant_id` → `merchant_system_urn`.
- Tinybird column `bot_events_raw.merchant_id` → `merchant_system_urn` (with matching JSONPath + sorting key). Pipe templates and JWT `--fixed-params` follow.
- Demo `.dev.vars` collapsed two redundant URN-related vars (`MERCHANT_ID` half-URN + `MERCHANT_SYSTEM_URN` full URN) into a single `MERCHANT_SYSTEM_URN` (full URN), used both for analytics emission and license.xml proxy fetches.
- Fastly options' discriminated union (RSL on/off requiring different fields) collapsed to a flat interface — URN is now always required for analytics, reused for license.xml when `enableRSL: true`.

**Verification:** all four e2e harnesses + 97 vitest tests pass
post-rename. Local Tinybird wiped + redeployed (column rename is not
in-place for MergeTree).

### Phase 4 — Dashboard (Option β)  ⏳ next

**Goal:** validate the read-side API path that an eventual real
dashboard will use, without coupling to the in-flight merchant frontend.

**Plan, in order:**
1. **`GET /merchants/me/analytics-token`** in `supertab-connect/backend/` — returns a short-TTL Tinybird JWT bound to the caller's merchant system URN via `--fixed-params merchant_system_urn=...`. ~one handler, depends on `current_merchant`.
2. **`dashboard.html`** (vanilla JS or React) — fetches the token, calls `traffic_summary.json` against the local Tinybird with a chosen time window. Renders bot traffic by hour and `bot_label`. Merchant-swap dropdown for testing isolation in the UI.

**Don't proxy queries through FastAPI** — that throws away Tinybird's
read-isolation guarantee. Backend's only job is mint-token.

**Verification target:** Token A's view shows only Token A's data;
pattern updates in `bot_ua_patterns` are visible in the dashboard
within seconds; the bot-categories breakdown looks like something a
merchant could act on.

**Adjacent conversation:** the "five merchant questions" exercise
should happen before or during this phase — with real synthetic data
flowing, the conversation gets sharper.

---

## The model

Three separated concerns:

| Concern | Lives in | When |
|---|---|---|
| **Identification** — "this UA contains GPTBot" | Warehouse (`bot_ua_patterns`) | Query time |
| **Classification** — "GPTBot is in `ai_training`" | Warehouse (`bot_ua_patterns`) | Editorial / query time |
| **Enforcement** — "block AI training, allow search" | SDK | Real time at the edge |

The SDK does **policy lookup**, not bot detection — even though today's
`defaultBotDetector` and `BotVerdict` shape look like detection. Those
are transitional for v1 (no per-merchant policies yet). Real-time
enforcement at the edge still needs pattern matching, but the SDK
doesn't need to know what *kind* of bot a UA is — only whether it
matches one of the merchant's policy rules.

**The merchant flow this enables:**

1. Merchant deploys SDK in observe mode — events emit, no enforcement.
2. Tinybird classifies via `bot_ua_patterns` — merchant sees their
   actual bot traffic in the dashboard, broken down by bot/category.
3. Merchant chooses — block GPTBot, allow Googlebot, observe Perplexity.
4. Decisions persist in the backend (per-merchant policy table).
5. SDK loads the policy and enforces it at the edge.

**Implication:** the `bot_detector_result` schema field is misnamed
under this model. Don't rename now — defer until policy-based
enforcement is closer.

---

## Architecture

```
                                 ┌─────────────────┐
   edge request ──► SDK at edge ─┤                 │
                                 │  fire-and-forget│
                                 ▼                 ▼
                          ┌──────────────┐   ┌──────────────┐
                          │  /events     │   │ bot_events_  │
                          │  (billing)   │   │ raw          │
                          │  Aurora      │   │ Tinybird     │
                          └──────────────┘   └──────────────┘
                                                   ▲
                                                   │ JWT --fixed-params
                                                   │ merchant_system_urn
                                                   │
                                                ┌──┴───────┐
                                                │ dashboard│
                                                └──────────┘
```

Two pipelines, isolated:

- **Existing path** (unchanged): SDK → `api-connect.supertab.co/events`
  → backend → billable event recording. Synchronous-ish, billing-grade.
- **New path** (this work): SDK fire-and-forget → Tinybird Events API →
  `bot_events_raw`. Best-effort, never blocks request handling, failures
  cannot affect billing.

---

## File inventory

### `connect-sdk-typescript/`

```
src/
  index.ts              SupertabConnect class; three CDN entry handlers
  types.ts              SupertabConnectConfig (with merchantSystemUrn), Env
  cdn.ts                Per-CDN context plumbing (sourceCdn, clientIp)
  bots.ts               defaultBotDetector returning BotVerdict
  license.ts            ES256 license token verification (RSL)
  customer.ts           Customer JWT generation; OAuth2 license fetch
  jwks.ts               JWKS fetch + cache
  analytics/
    types.ts            AnalyticsEvent, BotVerdict, TokenOutcome, etc.
    ip.ts               normalizeClientIp (IPv4 → ::ffff:, IPv6 passthrough)
    buildAnalyticsEvent.ts
    transport.ts        HttpAnalyticsTransport, NoopAnalyticsTransport

tests/
  analytics/            vitest unit tests (40 tests, all pass)
  e2e/
    cloudflare-e2e.ts             6-branch analytics pipeline (workerd)
    read-isolation.ts             read-side multi-tenancy
    classification-e2e.ts         seed sanity + 12 canonical UAs + disambiguation
    seed-bot-ua-patterns.ts       idempotent seed loader
    enforcement.test.ts           Worker HTTP behavior (vitest, separate from harnesses)

demos/cloudflare/
  src/index.ts          Demo Worker (RSL proxy + CAP via SDK)
  origin.ts             Publisher origin (port 8789); also exports startOrigin()
  .dev.vars             Local config (gitignored)
```

### `supertab-connect/tinybird/` (`tiny-bird` branch)

```
tinybird/datasources/
  bot_events_raw.datasource     90-day TTL, MergeTree, sorting key on
                                merchant_system_urn + timestamp + request_id
  bot_ua_patterns.datasource    ReplacingMergeTree on (pattern_id) by updated_at

tinybird/pipes/
  traffic_summary.pipe          Production rollup; auth via JWT + fixed_params
  merchant_event_count.pipe     Helper for read-isolation harness

tinybird/seed_bot_ua_patterns.ndjson      171 hand-curated rows
tinybird/seed_bot_ua_patterns.README.md   sources + band convention + addition workflow
```

---

## Tinybird schema

### `bot_events_raw`

17 fields. Key ones:

- `merchant_system_urn` String — the per-row tenancy key (full URN form)
- `timestamp` DateTime64(3, 'UTC')
- `request_id` String — `crypto.randomUUID()` per request
- `source_cdn` LowCardinality(String) — `cloudflare | fastly | cloudfront`
- `user_agent`, `client_ip` (IPv6 string), `path`, `method`, `referer`, `accept_language`
- `has_token` Bool
- `token_outcome` LowCardinality(String) — `absent | valid | malformed | expired | invalid_signature | invalid_audience | invalid_resource | invalid_issuer | server_error`
- `bot_detector_result` LowCardinality(String) — `human | unverified_bot | suspicious | unknown | verified_bot` (last reserved/unreachable)
- `final_action` LowCardinality(String) — `allow | observe | block`
- `enforcement_mode` LowCardinality(String) — `disabled | observe | enforce`

Engine `MergeTree`, partition `toYYYYMM(timestamp)`, sorting key
`(merchant_system_urn, timestamp, request_id)`, TTL 90 days.

### `bot_ua_patterns`

Per-pattern row: `pattern_id` (UInt32, priority — lower wins),
`pattern` (String), `match_type` (`exact | prefix | contains | regex`),
`bot_label`, `bot_category`, `is_active` (Bool), `updated_at`.

Engine `ReplacingMergeTree(updated_at)` on key `pattern_id` — re-seeding
just bumps `updated_at` and reads via `FROM bot_ua_patterns FINAL`.

**Band convention (lower `pattern_id` = higher priority via `argMin`):**

| Range | Use |
|-------|-----|
| 1–199 | Specific AI bots |
| 200–499 | Search indexers |
| 500–599 | Page preview bots |
| 600–699 | Archivers |
| 700–899 | SEO tools |
| 900–999 | Library / dev tooling |
| 1000+ | Generic catch-alls |

Specific patterns must always sit below generics that could also match
them. Tested in `classification-e2e.ts` block (c).

### `traffic_summary.pipe`

Production rollup endpoint. Three nodes:

1. `active_patterns` — latest active version of each UA pattern.
2. `classified_events` — events for the merchant in the time window,
   joined to patterns via a `matched` CTE (`CROSS JOIN + WHERE` keyed
   on `request_id`, then equi-`LEFT JOIN`). Unmatched events resolve
   to `'unclassified'`. The CTE shape is required because ClickHouse
   rejects non-equi predicates in `LEFT JOIN ... ON` and the bypass
   setting is restricted on Tinybird.
3. `hourly_rollup` — final aggregation: hourly buckets, `bot_label` +
   `final_action` counts.

Auth: JWT with `--fixed-params merchant_system_urn=<urn>` injected.
Templated params: `merchant_system_urn`, `from_ts` (DateTime64),
`to_ts` (DateTime64).

### `merchant_event_count.pipe`

Single-node helper: `SELECT count() FROM bot_events_raw WHERE merchant_system_urn = {{ String(merchant_system_urn, required=True) }}`. Used only by
`read-isolation.ts` because `traffic_summary` requires seeded patterns.

---

## SDK configuration

### `SupertabConnectConfig`

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | string | yes | Rotatable credential |
| `merchantSystemUrn` | string | yes | Full URN form (`urn:stc:merchant:system:<uuid>`); stable across key rotation |
| `enforcement` | EnforcementMode | no | Default `OBSERVE` |
| `botDetector` | BotDetector | no | `(req, ctx?) => BotVerdict` |
| `analyticsEnabled` | boolean | no | Default `false` |
| `analyticsToken` | string | no | Required when `analyticsEnabled: true` |
| `analyticsEndpoint` | string | no | Default europe-west2 Tinybird |
| `analyticsTransport` | AnalyticsTransport | no | DI hook for tests |
| `debug` | boolean | no | Per-request debug logging |

### Cloudflare `Env`

```
MERCHANT_API_KEY            # rotatable credential
MERCHANT_SYSTEM_URN         # full URN
SUPERTAB_ANALYTICS_TOKEN    # optional; enables analytics when set
```

### Demo `.dev.vars`

```
MERCHANT_API_KEY=<key>
MERCHANT_SYSTEM_URN=urn:stc:merchant:system:<uuid>
SUPERTAB_ANALYTICS_TOKEN=<workspace admin from `tb --local token ls`>
SUPERTAB_ANALYTICS_ENDPOINT=http://localhost:7181/v0/events?name=bot_events_raw
SUPERTAB_BASE_URL=http://localhost:8000
ORIGIN_URL=http://127.0.0.1:8789
ALLOW_TEST_OVERRIDES=true   # honors X-Test-Enforcement / X-Test-Bot-Detection headers
```

**Wrangler does not hot-reload `.dev.vars`.** After editing it, restart
`wrangler dev`. The Worker will silently emit to Tinybird with the old
token otherwise (transport swallows non-2xx).

---

## Test harnesses

| Harness | What it tests | Needs |
|---|---|---|
| `tests/analytics/*.test.ts` | unit (vitest) — `buildAnalyticsEvent`, transports | nothing (pure) |
| `tests/e2e/seed-bot-ua-patterns.ts` | seed loader is idempotent | Tinybird Local |
| `tests/e2e/read-isolation.ts` | per-URN JWT isolation; URL override probe | Tinybird Local |
| `tests/e2e/classification-e2e.ts` | seed sanity + 12 canonical UAs + band-convention disambiguation | Tinybird Local + seed |
| `tests/e2e/cloudflare-e2e.ts` | all 6 SDK emit branches end-to-end through workerd | Tinybird Local + wrangler dev + supertab-connect backend + origin |
| `tests/e2e/enforcement.test.ts` | Worker HTTP behavior (vitest) | wrangler dev + supertab-connect backend |

---

## Cheatsheet

### Bring everything up (from scratch)

```bash
# 0. SDK build
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript && npm run build
cd demos/cloudflare && npm install   # re-resolves file:../.. link after rebuild

# 1. supertab-connect backend on :8000
cd /Users/hassaanelgarem/supertab/supertab-connect && docker compose up backend

# 2. Tinybird Local on :7181 (skip if you don't need analytics)
cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird && tb dev

# 3. Publisher origin on :8789 (skip if only running cloudflare-e2e — it starts its own)
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript
npx tsx demos/cloudflare/origin.ts

# 4. Worker on :8788
cd demos/cloudflare && npx wrangler dev --port 8788 --ip 127.0.0.1
```

**Port roles:**
- `:8000` supertab-connect backend (license tokens, JWKS, license.xml)
- `:7181` Tinybird Local
- `:8788` Worker (publisher URL; what tests hit; license token `aud` is bound to this)
- `:8789` publisher origin (the fake "publisher website" the Worker forwards to)

**The merchant system's `base_url` in the local backend must equal `http://127.0.0.1:8788`** — that's what gets stamped into license token `aud` and what the SDK validates against.

### Run harnesses

```bash
# admin token (refresh after Tinybird workspace rebuild)
TB_ADMIN_TOKEN=$(cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird && \
  tb --local token ls | awk '/^name: workspace admin token/{getline; print $2}')

# unit tests
npx vitest run

# seed (idempotent)
TB_ADMIN_TOKEN=$TB_ADMIN_TOKEN npx tsx tests/e2e/seed-bot-ua-patterns.ts

# read-side isolation
TB_ADMIN_TOKEN=$TB_ADMIN_TOKEN npx tsx tests/e2e/read-isolation.ts

# classification (needs seed)
TB_ADMIN_TOKEN=$TB_ADMIN_TOKEN npx tsx tests/e2e/classification-e2e.ts

# all 6 emit branches in workerd (needs wrangler dev + backend + origin)
TB_ADMIN_TOKEN=$TB_ADMIN_TOKEN npx tsx tests/e2e/cloudflare-e2e.ts
```

### Inspect Tinybird

```bash
cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird
tb --local datasource ls
tb --local pipe ls
tb --local token ls
tb --local --token "$TB_ADMIN_TOKEN" sql \
  "SELECT count() FROM bot_events_raw WHERE merchant_system_urn = '<urn>'"
```

### When local Tinybird gets weird

Cache goes stale after a chain of failed builds. Reset:

```bash
tb local clear --yes
tb --local deploy
# refresh SUPERTAB_ANALYTICS_TOKEN in demos/cloudflare/.dev.vars from the new
# `tb --local token ls`, then RESTART wrangler (it doesn't hot-reload .dev.vars)
```

After a column rename to `bot_events_raw`, you must clear + redeploy
(MergeTree doesn't support column rename in place).

### Tinybird Local UI

`http://cloud.tinybird.co/local/7181/relgarem_workspace` — same domain
as cloud, routed through your local instance via the
`/local/<port>/<workspace>` prefix.

---

## Authentication model and multi-tenancy

### Write side (current — trust-based)

SDK POSTs NDJSON directly to Tinybird Events API with a static
append-scoped token. Tinybird does **not** support write-side row-level
capabilities — `merchant_system_urn` is just a JSON field, and any
holder of the append token can technically write rows under any URN.

**Multi-tenancy on writes is a trust assumption, not an enforced
boundary.** This is documented in the README under "Known Limitations."
The fix (backend relay) is deferred — see below.

### Read side (verified)

Tinybird JWT tokens **do** support row-level scoping via
`--fixed-params merchant_system_urn=<urn>` on `PIPES:READ` scopes.
`tests/e2e/read-isolation.ts` proves: token A bound to A's URN sees only
A's rows; passing `?merchant_system_urn=<B>` in the URL is **silently
overridden** by Tinybird with the JWT-bound value.

---

## Deferred work

| Item | Trigger to revisit |
|---|---|
| **Backend analytics relay** | Before any merchant onboarding beyond friendly partners; before any external security review. SDK posts via `apiKey` → backend stamps `merchant_system_urn` server-side → Tinybird. Replaces the write-side trust assumption. When this ships, `merchantSystemUrn` moves out of SDK config (becomes backend-derived). |
| **`bot_detector_result` field rename** | When policy-based enforcement is closer. Field is misnamed under the policy model — should reflect "did the SDK match a policy rule?", not "what kind of bot." |
| **Policy-based enforcement** (eventual replacement for `defaultBotDetector`) | Long-term roadmap. The SDK's eventual job is policy lookup, not bot detection. |
| **Pattern priority column on `bot_ua_patterns`** | First editorial conflict (multiple patterns matching the same UA with different `bot_label`). Today the band convention encodes priority implicitly via `argMin(_, pattern_id)`. |
| **Automated `ai.robots.txt` diff/sync** | When manual seed cadence becomes a bottleneck. Currently 171-row hand-curated seed; new entries require a human edit + re-running `seed-bot-ua-patterns.ts`. |
| **KnownAgents API integration** | Same trigger. Hand-cross-referenced today. |
| **Regex-pattern support in `winningPattern` query** | When the seed gains its first `match_type='regex'` row. ClickHouse rejects `match()` with constant haystack + column needle, so the harness's direct-argMin SQL omits the regex branch. The real `traffic_summary` handles regex fine because both sides are columns there. |
| **Materialized rollup for `traffic_summary`** | When query latency at real merchant volume exceeds the dashboard SLO. Catch: MVs are insert-time triggers; pattern updates only affect new traffic. Today's query-time classification reclassifies all history when patterns change. Escape hatch: periodic `INSERT INTO bot_events_classified SELECT ...` job. |
| **Native CDN log transports** (Fastly log streaming, CloudFront → S3 → Tinybird connector) | After all-CDNs MVP pass. Replaces `HttpAnalyticsTransport` per CDN where the operational win justifies the work. The `AnalyticsTransport` interface exists specifically to make this swap painless. |
| **All-CDNs MVP pass** (Fastly + CloudFront) | After Phase 4. Same SDK code paths, same `HttpAnalyticsTransport`. |
| **Demos `cloudfront/` and `fastly/`** | Same trigger as all-CDNs pass. Both still import the published `^0.1.0-beta.19` package and need a `merchantSystemUrn` source. `demos/cloudflare/` is current. |
| **Periodic "unknown enum values" sanity query** | Compensates for lost Tinybird-side enum validation (`LowCardinality(String)` instead of `Enum8` per JSONPaths constraint). Small pipe that counts unexpected values per enum-shaped column. |

---

## Dropped ideas

| Idea | Reason |
|---|---|
| **Run `defaultBotDetector` on the token-present path** to populate analytics | Identification belongs in the warehouse, not the SDK. The `user_agent` is captured on every event; classification resolves at query time via `bot_ua_patterns`. Originally surfaced as "isn't `bot_detector_result: 'unknown'` on licensed traffic wrong?" — under the policy reframing, it isn't wrong, the field is just misnamed. |
| **Per-merchant append tokens** as a write-side fix | Narrows blast radius but doesn't actually prevent spoofing — the token still doesn't constrain `merchant_system_urn`. Backend relay is the real fix. |

---

## Concepts to remember

### Why the Tinybird schema diverged from the original design

Tinybird's JSONPaths ingestion (the `json:$.field` annotations) supports
a restricted type subset: numerics, `String`, `FixedString`,
`LowCardinality(String)`, `Date`, `DateTime`, `DateTime64`, `Bool`, and
arrays of those.

Rejected:
- `Enum8(...)` — would require per-row enum-set validation in the hot ingest path
- `IPv6` — would require string→16-byte parsing in the hot ingest path

Result for `bot_events_raw`: `client_ip` is `String`, four enum-shaped
columns (`final_action`, `token_outcome`, `bot_detector_result`,
`enforcement_mode`) are `LowCardinality(String)`. Compile-time
validation still happens at the SDK type layer (string-union types in
`src/analytics/types.ts`); the "unknown enum values" deferred item
exists to compensate for the lost ingest-time validation.

### Materialized rollups (and why we don't have one yet)

A pre-computed summary table. Instead of running the same expensive
query on every dashboard load, the system computes it once when data
arrives and stores the result.

- **Today:** `traffic_summary` runs on every dashboard load — scan
  `bot_events_raw` for the merchant's rows in the time window, JOIN
  against `bot_ua_patterns`, group by hour, return ~24 rows. At 1M
  events in window: 1M rows scanned per refresh.
- **With an MV:** as each new event arrives, the MV runs the JOIN and
  writes a row to `bot_events_classified`. A separate rollup
  aggregates that into hourly buckets. Dashboard queries the rollup —
  24 rows scanned, not 1M.
- **Why not now:** at synthetic test volume, the expensive query runs
  in milliseconds. The Tinybird setup doc was explicit: don't build
  rollups until measurably necessary.
- **The catch when we eventually need it:** MVs are insert-time
  triggers. They process each row exactly once, when it arrives.
  **Pattern updates only affect new traffic.** Yesterday's events keep
  yesterday's labels. The current schema deliberately classifies at
  query time so pattern updates immediately reclassify everything
  including history.
- **Escape hatch:** keep `bot_events_raw` immutable and pattern-free,
  use a periodic `INSERT INTO bot_events_classified SELECT ... FROM
  bot_events_raw JOIN bot_ua_patterns` job to refresh weekly or on
  pattern updates. Slower than a true MV but preserves the ability to
  reclassify history.

### Other things worth knowing on resume

- **`tb --local workspace current`** doesn't work (`workspace` is cloud-only).
- **`tb --local token create static <name> --scope DATASOURCES:APPEND:bot_events_raw`** is rejected: "Adding or modifying resource-scoped tokens to this workspace can only be done via deployments." Use the workspace admin token from `tb --local token ls` for everything that needs append/admin scope.
- **`tb token create jwt`** works fine and is the way to mint per-merchant read tokens. Pass `--fixed-params` as a single arg in `child_process.execSync`.
- **`tb` CLI resolves resources from cwd**. Calling `tb --local pipe ls` from the SDK repo returns an empty list; calling it from `supertab-connect/tinybird/` works. `read-isolation.ts` sets `cwd: TB_PROJECT_DIR` on its `execSync`.
- **DateTime64 in templated pipe params**: ClickHouse expects `YYYY-MM-DD HH:MM:SS.fff` (with milliseconds). ISO 8601 with `T` and `Z` is rejected.
- **Wrangler 4.86 local mode (workerd) reaches `localhost` cleanly** — no tunnel needed for the SDK to POST to local Tinybird.
- **Wrangler auto-injects `cf-connecting-ip`** (default `127.0.0.1`) when the curl omits it; explicit values override.

---

## Open questions

- **`merchant_event_count.pipe` namespacing** — currently sits in
  `tinybird/tinybird/pipes/` next to production pipes. Could move to
  `_test/` or `_fixtures/` namespace. Decision deferred ("keep for
  now" was the call last review).
- **Backend analytics relay shape** — separate service, or extension
  of the existing `/events` handler? Lean: separate service, so
  analytics traffic bursts can't degrade the billing path. Decision
  not needed until the relay is actually being built.
