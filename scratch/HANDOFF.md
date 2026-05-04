# Bot Traffic Analytics — Handoff (What's Built)

State as of 2026-04-30. File-level record of what shipped in the SDK v2.0
analytics work. **Scope: built and Phase 1-tested locally only — not
released, not yet validated in any real CDN runtime.**

For the wider strategic picture (phased MVP plan, deferred work, dropped
ideas, the policy-vs-detection reframe), see
`scratch/ANALYTICS_MVP_STATE.md`. This file stays focused on what
actually exists today.

> **⚠️ Important framing — read before acting on this doc:**
> The SDK's `defaultBotDetector` and `BotVerdict` return type are
> **transitional**. The long-term SDK direction is **policy lookup at
> the edge**, not bot detection. Identification (what kind of bot is
> this?) belongs in the warehouse via `bot_ua_patterns` resolved at
> query time. The `bot_detector_result` schema field is misnamed for
> the long term; intentionally not renamed now. See
> `ANALYTICS_MVP_STATE.md` §"Reframing" for the full story.

---

## 1. Goal

Build an async bot traffic analytics pipeline distinct from the existing
billing/RSL events flow.

- **Existing path** (unchanged): SDK → `api-connect.supertab.co/events` →
  backend → billable event recording. Synchronous-ish, billing-grade.
- **New path** (this work): SDK fire-and-forget → Tinybird Events API →
  `bot_events_raw` datasource. Best-effort, never blocks request handling,
  failures cannot affect billing.

Deliverable in the current PR: a **major SDK version bump (1.4.1 → 2.0.0)**
with the new analytics module, breaking enum renames, three-state action
type, typed bot verdicts, and the new merchant identifier separation.

**This is an MVP build, not a release.** The v2.0 changes are too large
to ship to production without further validation in a real CDN runtime
(Phase 2 of the MVP plan — see `ANALYTICS_MVP_STATE.md`).

## 2. Repos and locations

| Repo | Purpose | Path |
|------|---------|------|
| `supertab-connect/tinybird/` | Tinybird datasources, pipes, deployments | `/Users/hassaanelgarem/supertab/supertab-connect/tinybird/` |
| `connect-sdk-typescript/` | Edge SDK (Cloudflare Workers, Fastly Compute, CloudFront L@E) | `/Users/hassaanelgarem/supertab/connect-sdk-typescript/` |
| `supertab-connect/backend/` | FastAPI backend (existing billing /events). **Not modified in this PR.** | `/Users/hassaanelgarem/supertab/supertab-connect/backend/` |

Branch on the SDK side: `pr-29` (current).

---

## 3. Tinybird schema

### 3.1 `bot_events_raw` datasource

File: `tinybird/tinybird/datasources/bot_events_raw.datasource`

```
DESCRIPTION >
    Raw bot/agent events emitted from edge SDK (Fastly Compute,
    Cloudflare Tail Workers, CloudFront standard logs). Append-only,
    schema-versioned, 90-day TTL. Bot classification happens at query
    time via dictGet against bot_ua_patterns; this table stores raw UA only.

SCHEMA >
    `merchant_id` String `json:$.merchant_id`,
    `timestamp` DateTime64(3, 'UTC') `json:$.timestamp`,
    `request_id` String `json:$.request_id`,
    `schema_version` UInt16 `json:$.schema_version`,
    `source_cdn` LowCardinality(String) `json:$.source_cdn`,

    `user_agent` String `json:$.user_agent`,
    `client_ip` String `json:$.client_ip`,
    `path` String `json:$.path`,
    `method` LowCardinality(String) `json:$.method`,
    `referer` String `json:$.referer`,
    `accept_language` String `json:$.accept_language`,

    `has_token` Bool `json:$.has_token`,
    `token_outcome` LowCardinality(String) `json:$.token_outcome`,
    `bot_detector_result` LowCardinality(String) `json:$.bot_detector_result`,
    `final_action` LowCardinality(String) `json:$.final_action`,
    `enforcement_mode` LowCardinality(String) `json:$.enforcement_mode`

ENGINE "MergeTree"
ENGINE_PARTITION_KEY "toYYYYMM(timestamp)"
ENGINE_SORTING_KEY "merchant_id, timestamp, request_id"
ENGINE_TTL "toDateTime(timestamp) + toIntervalDay(90)"
```

### 3.2 Schema divergences from original design

These are forced by Tinybird's JSONPaths ingestion constraints. JSONPaths
(the `json:$.field` annotations) is a hot ingest path that supports a
restricted subset of ClickHouse types: numerics, `String`, `FixedString`,
`LowCardinality(String)`, `Date`, `DateTime`, `DateTime64`, `Bool`, arrays
of those.

| Field | Designed | Shipped | Why |
|-------|----------|---------|-----|
| `client_ip` | `IPv6` | `String` | JSONPaths rejects `IPv6` (would require string→16-byte parsing in the JSON path) |
| `final_action` | `Enum8(...)` | `LowCardinality(String)` | JSONPaths rejects `Enum8` (would require per-row enum-set validation) |
| `token_outcome` | `Enum8(...)` | `LowCardinality(String)` | same |
| `bot_detector_result` | `Enum8(...)` | `LowCardinality(String)` | same |
| `enforcement_mode` | `Enum8(...)` | `LowCardinality(String)` | same |

**Trade-off accepted**: lost Tinybird-side enum validation. Compile-time
validation still happens at the SDK type layer (TS string-union types in
`src/analytics/types.ts`). Future SDK bug or forged direct POST could
write an unknown string and we wouldn't catch it at ingest. Mitigation:
periodic "unknown values" sanity query; not implemented yet.

`bot_events_raw_quarantine` is auto-created by Tinybird on ingest validation
failures. We've never hit it during testing — the count query errors with
"Datasource not found" because Tinybird doesn't materialize it until needed.

### 3.3 Final enum value sets

After the ambiguity-resolution pass:

- `final_action`: `allow | observe | block` (removed `challenge`)
- `token_outcome`: `absent | valid | malformed | expired | invalid_signature | invalid_audience | invalid_issuer | server_error`
- `bot_detector_result`: `human | unverified_bot | suspicious | unknown | verified_bot` (`verified_bot` reserved/unreachable)
- `enforcement_mode`: `disabled | observe | enforce`

### 3.4 Other Tinybird files

- `bot_ua_patterns.datasource` — `ReplacingMergeTree` with `ENGINE_VER "updated_at"`. Fixed earlier (was `ENGINE_VERSION`, which Tinybird rejected). **Phase 3 added JSONPaths annotations** (`json:$.field` on each column); same fields/types/engine, purely metadata. Required to enable NDJSON ingest via the Events API — the original schema only supported CSV. Seed file lives at `tinybird/tinybird/seed_bot_ua_patterns.ndjson` (171 rows); README at `seed_bot_ua_patterns.README.md`.
- `traffic_summary.pipe` — production rollup endpoint. **Phase 3 restructured the `classified_events` node.** The original used `LEFT JOIN bot_ua_patterns ON (OR-chain of non-equi match-type predicates)`, which ClickHouse rejects with `Cannot determine join keys` regardless of whether patterns are seeded. The bypass setting (`allow_experimental_join_condition`) is restricted on Tinybird. New shape: a `matched` CTE pre-classifies via `CROSS JOIN + WHERE` grouped by `request_id`, then an equi-`LEFT JOIN` from events resolves to either the winning label or `'unclassified'` (via an `is_matched` flag, since CH defaults missing-side String columns to `''` not `NULL` on `LEFT JOIN`). Output schema unchanged. **Earlier HANDOFF text claimed this pipe "works when patterns are seeded" — that was wrong; it had simply never been exercised.**
- `merchant_event_count.pipe` — **new helper**, added solely for the read-isolation harness. One node, returns `count() FROM bot_events_raw WHERE merchant_id = {{ String(merchant_id, required=True) }}`. Decide before merge whether this is permanent or moves to a `_test/` namespace.

---

## 4. SDK v2.0 changes

Package: `@getsupertab/supertab-connect-sdk@2.0.0`.

### 4.1 New analytics module (`src/analytics/`)

| File | Purpose |
|------|---------|
| `types.ts` | `AnalyticsEvent` (17 fields), `BotVerdict`, `TokenOutcome`, `FinalAction`, `Decision`, `AnalyticsTransport`, `SCHEMA_VERSION = 1`, `TOKEN_OUTCOME_BY_REASON` mapping |
| `ip.ts` | `normalizeClientIp()` — IPv4 → `::ffff:a.b.c.d`, IPv6 passthrough, `'::'` for missing/invalid |
| `buildAnalyticsEvent.ts` | Pure builder. `event.timestamp = date.toISOString()` (no `+00:00` rewrite — that previously broke ingestion) |
| `transport.ts` | `HttpAnalyticsTransport` with `ctx.waitUntil` support, debug logging that prints Tinybird's response body on failure; `NoopAnalyticsTransport`; `DEFAULT_ANALYTICS_ENDPOINT` = `https://api.europe-west2.gcp.tinybird.co/v0/events?name=bot_events_raw` |

### 4.2 Type changes (`src/types.ts`)

- **`EnforcementMode` rename + value change** — `SOFT` → `OBSERVE`, `STRICT` → `ENFORCE`, `DISABLED` unchanged. Underlying string values changed alongside the keys (`"soft"` → `"observe"`, `"strict"` → `"enforce"`). Raw-string callers silently fall back to `OBSERVE`. CHANGELOG calls this out explicitly.
- **`HandlerAction` is now three-state**: `ALLOW | OBSERVE | BLOCK`. The soft-mode signal path used to return `ALLOW + headers`; now returns `OBSERVE + headers`.
- **`BotDetector` return type**: `(req, ctx?) => boolean` → `(req, ctx?) => BotVerdict`.
- **New required `merchantId: string`** on `SupertabConnectConfig`. Stable identifier for analytics; `apiKey` remains the rotatable credential.
- **`Env.MERCHANT_ID: string`** (Cloudflare Worker bindings).
- **`CloudfrontHandlerOptions.merchantId: string`** (required).
- **`FastlyHandlerOptions.merchantId: string`** (required, on the base options interface).
- **`fastlyHandleRequests(request, merchantApiKey, originBackend, options)`** — `options` is no longer optional, since `merchantId` lives on it.

### 4.3 Behavioral changes (`src/index.ts`)

- `handleRequest(request, context?)` — second arg changed from `ExecutionContext` to `HandleRequestContext { ctx?, sourceCdn, clientIp?, requestId? }`. Hard break (no overload).
- Per-request `request_id` is `crypto.randomUUID()` if not provided in context.
- Constructor builds analytics transport once; warns at warn-level (once, not per request) if `analyticsEnabled: true` but `analyticsToken` missing, then falls back to `NoopAnalyticsTransport`.
- `emit(decision)` is called at every return point (allow/observe/block/token-present-allow/token-present-block) inside a try/catch — billing path is fully isolated.
- Singleton conflict detection now compares both `apiKey` and `merchantId`.
- Three CDN entry handlers (`cloudflareHandleRequests`, `fastlyHandleRequests`, `cloudfrontHandleRequests`) updated to thread `merchantId` through.

### 4.4 Per-CDN context plumbing (`src/cdn.ts`)

`handleCloudflareRequest` / `handleFastlyRequest` / `handleCloudfrontRequest` build a `HandleRequestContext` from the platform's request object:

- Cloudflare: `sourceCdn: "cloudflare"`, `clientIp: req.headers.get("cf-connecting-ip")`, `ctx` from worker
- Fastly: `sourceCdn: "fastly"`, `clientIp: req.headers.get("fastly-client-ip")`
- CloudFront: `sourceCdn: "cloudfront"`, `clientIp: event.Records[0].cf.request.clientIp`

### 4.5 The token-present path skips the bot detector

By design and confirmed: when an `Authorization: License ...` header is
present, the SDK validates the token and skips bot detection entirely.
Analytics events emitted on this path always have `bot_detector_result: "unknown"`.

This was originally raised as a possible follow-up ("should the SDK still
run the bot detector to populate the analytics row?"). **Dropped.**
Reason: under the long-term enforcement model (see the framing note at
the top of this file and `ANALYTICS_MVP_STATE.md`), bot identification
is a warehouse concern. The `user_agent` is captured on every event;
classification happens at query time via `bot_ua_patterns`. The SDK
does not need to participate in identification on the token-present
path or any other path.

---

## 5. The `apiKey` vs `merchantId` split

### 5.1 Why this exists

Originally the SDK reused `config.apiKey` as the analytics `merchant_id`.
Two problems:

1. **`apiKey` is rotatable**. When a merchant rotates, all prior analytics
   rows orphan — the new key has no rows; the old key has rows with no
   live owner.
2. **`apiKey` is a credential**. Anything downstream that handles or logs
   `merchant_id` was technically handling a secret.

### 5.2 What we changed

- `merchantId: string` is now a **required** config field, separate from `apiKey`.
- Constructor throws if missing.
- `buildAnalyticsEvent` reads `this.merchantId`, never `this.apiKey`.
- All three CDN entry points expose `merchantId` (Cloudflare via env, Fastly/CloudFront via options).

### 5.3 What we did not change

- Analytics auth still uses a static append-scoped Tinybird token (`Authorization: Bearer <token>`).
- `merchantId` is still merchant-asserted (in JSON body), not server-stamped.
- Backend relay deferred — see §7.

---

## 6. Authentication model and multi-tenancy

### 6.1 Write side (current — trust-based)

SDK POSTs NDJSON directly to `https://api.europe-west2.gcp.tinybird.co/v0/events?name=bot_events_raw` with `Authorization: Bearer <append-scoped Tinybird token>`.

Tinybird does **not** support write-side row-level capabilities. The token
authorizes "append to `bot_events_raw`" — full stop. `merchant_id` is just
a JSON field. Any holder of the token can write rows under any
`merchant_id`. **Multi-tenancy on writes is a trust assumption**, not an
enforced boundary.

### 6.2 Read side (verified working)

Tinybird JWT tokens **do** support row-level scoping via
`--fixed-params merchant_id=<id>` on `PIPES:READ` scopes. The harness in
`tests/e2e/read-isolation.ts` proves this:

- Token A (bound to merchant A) sees only A's rows.
- Token B (bound to merchant B) sees only B's rows.
- Token A passing `?merchant_id=<B>` in the URL: **Tinybird silently overrides** with the JWT-bound value. A still sees A's rows.

### 6.3 Path forward (deferred)

Likely fix for the write-side trust gap: route analytics through the
backend (`api-connect.supertab.co/analytics` or similar). SDK posts with
its existing `apiKey`; backend authenticates, looks up merchantId from
apiKey, stamps it server-side, forwards to Tinybird with the service-
owned token. At that point, `merchantId` moves out of SDK config (becomes
backend-derived).

This is filed in the README under "Known Limitations" with a note that
the current `merchantId` SDK config field is **transitional**.

Decision recorded: **defer the backend relay; ship the merchantId split now.**

---

## 7. Test harnesses

The runnable harnesses live in `tests/e2e/` (consolidated there in
Phase 2.5 — earlier they sat in `scratch/`). They are developer
harnesses for local validation, not CI tests, because CI doesn't have a
Tinybird Local instance or a wrangler dev process.

### 7.1 Vitest unit tests (CI)

- `tests/analytics/buildAnalyticsEvent.test.ts` — 34 tests covering all event shape branches
- `tests/analytics/transport.test.ts` — 6 tests using `vi.stubGlobal("fetch")`
- 96 unit tests pass overall. One e2e test (`tests/e2e/enforcement.test.ts > Soft Mode > valid token gets 200`) was failing on `invalid_client` originally; with the Phase 2.5 local backend wiring it now passes against the local supertab-connect.

### 7.2 `tests/e2e/cloudflare-e2e.ts` (analytics pipeline E2E in workerd)

Single self-asserting harness covering all six SDK emission branches inside `wrangler dev`:

| # | Trigger | Expected analytics row |
|---|---------|------------------------|
| 1 | Real Chrome UA, OBSERVE | `final_action=allow`, `bot=human` |
| 2 | `GPTBot/1.0` UA, OBSERVE | `final_action=observe`, `bot=unverified_bot` |
| 3 | `ClaudeBot/1.0` UA, ENFORCE | `final_action=block`, `bot=unverified_bot` |
| 4 | `HeadlessChrome` UA, OBSERVE | `final_action=observe`, `bot=suspicious` |
| 5 | Bot UA + DISABLED | `final_action=allow` (kill-switch wins) |
| 6 | `Authorization: License not-a-real-jwt`, OBSERVE | `final_action=block`, `has_token=true`, `token_outcome=malformed` |

The Worker honors per-request enforcement / bot-detection overrides via `X-Test-Enforcement` / `X-Test-Bot-Detection` request headers when `.dev.vars` has `ALLOW_TEST_OVERRIDES=true`. The harness sets those headers per scenario.

Run (Tinybird Local + wrangler dev must be running — see `demos/cloudflare/README.md`):
```bash
TB_ADMIN_TOKEN=<workspace admin token> \
  npx tsx tests/e2e/cloudflare-e2e.ts
```

Self-asserting; exits non-zero on any failure. Replaces the earlier `scratch/local-emit.ts` (Node-only, manual) and the original three-scenario `scratch/cloudflare-e2e.ts`.

### 7.3 `tests/e2e/read-isolation.ts` (read-side multi-tenancy)

Self-asserting harness. Exits non-zero on any failure.

Strategy:
1. Append synthetic rows for two merchants (3 + 5 rows, distinct IDs per run).
2. Mint two `PIPES:READ` JWTs via `tb --local token create jwt ... --fixed-params merchant_id=...` (resolved against `TB_PROJECT_DIR`, default `../../supertab-connect/tinybird/` from `tests/e2e/`).
3. Query `merchant_event_count.json` with each token; assert row counts match.
4. Override probe: token A passes `?merchant_id=<B>` in the URL — assert it does not leak B's rows.

Run:
```bash
TB_ADMIN_TOKEN=<workspace admin token> \
npx tsx tests/e2e/read-isolation.ts
```

**Verified passing** end-to-end. The override probe outcome was `ignored` (Tinybird returned A's data, silently discarding the URL value).

### 7.4 `merchant_event_count.pipe`

Minimal one-node pipe used only by the read-isolation harness. Exists because `traffic_summary.pipe`'s ClickHouse JOIN is unsuitable for synthetic tests without seeded `bot_ua_patterns` data.

**Decision pending**: keep as a permanent fixture, or move under a `_test/` or `_fixtures/` namespace before the PR.

---

## 8. Tinybird Local operational notes

Hard-won during this work:

- **`tb --local workspace current`** doesn't work (`workspace` is cloud-only).
- **`tb --local token create static <name> --scope DATASOURCES:APPEND:bot_events_raw`** is rejected: "Adding or modifying resource-scoped tokens to this workspace can only be done via deployments." Use the workspace admin token from `tb --local token ls` for everything that needs append/admin scope.
- **`tb token create jwt`** works fine and is the way to mint per-merchant read tokens. Note: the `--fixed-params` value must not be re-shell-parsed; pass it as a single arg in `child_process.execSync` or quote it carefully.
- **`tb` CLI resolves resources from cwd**. Calling `tb --local pipe ls` from the SDK repo returns an empty list; calling it from `supertab-connect/tinybird/` works. `read-isolation.ts` sets `cwd: TB_PROJECT_DIR` on its `execSync`.
- **`tb build` / `tb --local deploy` cache can go stale** after a chain of failed builds. Reset with `tb local clear --yes` followed by re-deploy.
- **DateTime64 in templated pipe params**: ClickHouse expects `YYYY-MM-DD HH:MM:SS.fff` (with milliseconds). ISO 8601 with `T` and `Z` was rejected.

Local admin token (current session, will rotate):
```
p.eyJ1IjogIjc4MzMxMjFhLWYzNmEtNDMzOC1iODNlLWQ0MzFkN2ViNmVkOCIsICJpZCI6ICI0NjhmZmMxMi03ZDM2LTQ1N2UtYjYzNy0xMjEyZDBlNTY2OWUiLCAiaG9zdCI6ICJsb2NhbCJ9.yDgP5BbvhZdC2DMH-MmAsx0Xw9sq205YrG-YZMYArH4
```

Refresh from `tb --local token ls`.

---

## 9. Documentation updates

- `connect-sdk-typescript/CHANGELOG.md` — Keep-a-Changelog format; v2.0.0 section covers all breaking changes including the `merchantId` requirement and `fastlyHandleRequests` options-required change.
- `connect-sdk-typescript/README.md` — `merchantId` row in Configuration Options table; new "Known Limitations" section explaining the trust-based write-side multi-tenancy and that the field is transitional.
- The README config table still references the old `SOFT` / `STRICT` enforcement values — pre-existing staleness, intentionally not fixed in this scope. CHANGELOG covers it.

---

## 10. What's still open (scope of this PR)

This PR represents Phase 1 of the MVP plan (see `ANALYTICS_MVP_STATE.md`).
The list here is intentionally narrow — outstanding items beyond this PR
(Phase 2/3/4, deferred work, dropped ideas) live in that file.

### Before merging the SDK PR

1. **PR description** — pull together: schema divergences (IPv6→String, Enum8→LowCardinality, JSONPaths constraints), apiKey/merchantId split, write-side trust limitation, both test harnesses, the v2.0 breaking changes, and an explicit "MVP, not for production release" caveat.
2. **Decide `merchant_event_count.pipe` placement** — production pipes dir vs. a test-fixtures namespace.
3. **Demos not updated** — `demos/cloudfront/index.ts` and `demos/fastly/src/index.js` still import the published package and need a `merchantId` source. `demos/cloudflare/` was updated as part of Phase 2 / 2.5 work — links to local SDK via `file:../..`, plumbs the analytics env, uses the public `cloudflareHandleRequests`, and now also (a) proxies `/license.xml` to the local backend (mirrors the prod RSL Worker), (b) calls `setBaseUrl(env.SUPERTAB_BASE_URL)` to point JWKS / event-record at local supertab-connect, (c) passes `originUrl` so the Worker URL (`:8788` = publisher URL) and origin (`:8789`) can differ. See `ANALYTICS_MVP_STATE.md` Phases 2 + 2.5.
4. **SDK API addition (may revert)** — `cloudflareHandleRequests` gained an `originUrl?: string` option in `src/index.ts:441` and `handleCloudflareRequest` gained the same param in `src/cdn.ts:33`. Local-dev convenience to decouple license validation URL from pass-through fetch destination; production deployments using Workers Routes don't need it. User flagged for possible revert — see `ANALYTICS_MVP_STATE.md` Phase 2.5 for the off-ramps (drop `cloudflareHandleRequests` in the demo, or use `cloudflared` tunnel + `wrangler dev --remote`).

### Tracked elsewhere

- **Backend analytics relay**, **Phase 2/3/4 ramp**, **deferred work with triggers**, **dropped follow-ups (incl. token-present `botDetector`)**, **policy-based enforcement direction** → all in `scratch/ANALYTICS_MVP_STATE.md`.

---

## 11. File-level diff summary

### connect-sdk-typescript

```
M  package.json                        # 1.4.1 → 2.0.0
M  src/types.ts                        # EnforcementMode, HandlerAction, merchantId, MERCHANT_ID, FastlyHandlerOptions
M  src/index.ts                        # ctor, handleRequest, three CDN handlers, emit at all return points
M  src/bots.ts                         # defaultBotDetector returns BotVerdict
M  src/license.ts                      # buildSignalResult returns OBSERVE
M  src/cdn.ts                          # threads sourceCdn/clientIp via HandleRequestContext
A  src/analytics/types.ts
A  src/analytics/ip.ts
A  src/analytics/buildAnalyticsEvent.ts
A  src/analytics/transport.ts
A  tests/analytics/buildAnalyticsEvent.test.ts
A  tests/analytics/transport.test.ts
A  CHANGELOG.md
M  README.md                           # config table + Known Limitations
M  tests/e2e/README.md                 # SOFT → OBSERVE
M  .gitignore                          # + scratch/
A  tests/e2e/cloudflare-e2e.ts         # analytics pipeline E2E (workerd, all 6 emit branches)
A  tests/e2e/read-isolation.ts         # read-side multi-tenancy
A  scratch/HANDOFF.md                  # this file (gitignored)
A  scratch/ANALYTICS_MVP_STATE.md      # strategic / forward-looking (gitignored)
```

### supertab-connect/tinybird

```
M  tinybird/datasources/bot_events_raw.datasource     # JSONPaths, IPv6→String, Enum8→LowCardinality, TTL fix
M  tinybird/datasources/bot_ua_patterns.datasource    # ENGINE_VERSION → ENGINE_VER; Phase 3 added JSONPaths
M  tinybird/pipes/traffic_summary.pipe                # Phase 3 — classified_events restructured (CTE + equi-join) so the JOIN actually runs
A  tinybird/pipes/merchant_event_count.pipe           # helper for read-isolation harness
A  tinybird/seed_bot_ua_patterns.ndjson               # Phase 3 — 171-row hand-curated UA pattern seed
A  tinybird/seed_bot_ua_patterns.README.md            # Phase 3 — sources, band convention, addition workflow
```

### connect-sdk-typescript (Phase 3 additions)

```
A  tests/e2e/seed-bot-ua-patterns.ts     # idempotent NDJSON → Events API ingest, post-state count
A  tests/e2e/classification-e2e.ts       # 3 blocks: seed sanity, 12 canonical UAs, disambiguation
```

---

## 12. Cheatsheet for resuming

```bash
# SDK repo
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript

# Build
npm run build

# Unit tests (96 pass; 1 e2e failure pre-existing)
npx vitest run

# Analytics pipeline E2E (workerd; needs wrangler dev + Tinybird Local running)
TB_ADMIN_TOKEN=<admin> npx tsx tests/e2e/cloudflare-e2e.ts

# Read-side harness (self-asserting; needs Tinybird Local)
TB_ADMIN_TOKEN=<admin> npx tsx tests/e2e/read-isolation.ts

# Seed bot_ua_patterns from the NDJSON fixture (idempotent; needs Tinybird Local)
TB_ADMIN_TOKEN=<admin> npx tsx tests/e2e/seed-bot-ua-patterns.ts

# Classification harness (needs Tinybird Local + seeded patterns)
TB_ADMIN_TOKEN=<admin> npx tsx tests/e2e/classification-e2e.ts

# Tinybird repo
cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird

# Inspect what's deployed
tb --local datasource ls
tb --local pipe ls
tb --local token ls

# Query with admin
tb --local --token "<admin>" sql "SELECT count() FROM bot_events_raw WHERE merchant_id = '<id>'"

# Reset local if cache goes stale
tb local clear --yes
tb --local deploy
```
