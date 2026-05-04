# Bot Analytics Pipeline — Implementation Follow-Up

**Companions:** `analytics-mvp-build-plan.md` and `supertab-tinybird-setup.md`
**Status:** v2.0 SDK built and Phase 1 testing complete (local Node harness + read-isolation verified). About to start Phase 2 (Cloudflare Worker via `wrangler dev`). No real merchant traffic yet.

---

## Purpose

This document is a chronological record of what happened *after* the build plan and the Tinybird setup were drafted. It's written to be read top-to-bottom as a narrative — the decisions made sense in the order they were made, and reading the final state without the path to it loses information.

If you only want the current state, jump to the last section.

---

## Where things stood at the start

Two docs existed and were broadly correct in their direction:

- **`analytics-mvp-build-plan.md`** — strategic plan: two pipelines (Aurora for billing, Tinybird for analytics), one analytics event type, transport abstraction in the SDK, query-time bot classification, phased rollout.
- **`supertab-tinybird-setup.md`** — concrete Tinybird shape: `bot_events_raw.datasource` with 17 fields and four enums, `bot_ua_patterns.datasource` for classification, `traffic_summary.pipe` for the merchant-facing rollup.

Both were written before any code was touched. They captured intent, not validated implementation.

The implicit ingest plan in those docs was Option 3: per-merchant Tinybird JWT with `fixed_params: {merchant_id: ...}` baked into the token, distributed to merchants at onboarding, stored in their CDN secret store. Backend stays out of the analytics request path. This was the design we set out to implement.

---

## Step 1 — Schema review against the existing SDK

Before extending anything, we ran a code review against the SDK to find the gap between what the schema demanded and what the SDK actually emits today.

The gaps were real and numerous:

- `request_id`, `source_cdn`, `client_ip`, flat `path`/`method`/`referer`/`accept_language`, explicit `has_token` — none populated by the SDK today.
- Enum vocabulary mismatched. SDK uses `SOFT / STRICT / DISABLED`; Tinybird schema uses `observe / enforce / disabled`.
- Bot detector returns `bool`. Schema expects a five-value enum (`unknown | human | verified_bot | unverified_bot | suspicious`).
- `final_action` schema had four values including `challenge`. SDK has two values (`ALLOW | BLOCK`) plus an awkward "soft signal" path that returns ALLOW with a warning header.
- `token_outcome` enum was missing slots for SDK reasons like `INVALID_ISSUER` and `SERVER_ERROR`.

These weren't blockers — they were the work to be done.

---

## Step 2 — Three blockers, settled in order

The review surfaced three architectural choices that needed decisions before any other work could proceed.

### Blocker 1 — Ingest path

Three options:

- **(1) Direct from edge with shared write token.** Killed immediately: edge SDK bundles are publicly readable, the token would leak.
- **(2) Backend relay.** SDK posts to FastAPI, backend resolves merchant_id from API key, forwards to Tinybird. Rejected because every analytics event would hit the same backend that the request-path optimization work was meant to keep light.
- **(3) Per-merchant scoped Tinybird JWT, stored in CDN secret stores.** Backend mints at onboarding, merchant pastes into their CDN secrets like an API key. Edge talks straight to Tinybird. `fixed_params` enforces `merchant_id` server-side.

**Decision: Option 3.** Operationally cleaner, no backend in the request path, rotation pain is the same machinery already needed for the CloudFront Function JWK.

### Blocker 2 — Enum vocabulary

SDK's `SOFT / STRICT / DISABLED` vs schema's `observe / enforce / disabled`. Picking either means renaming the loser.

**Decision: schema wins.** SDK renames `SOFT → OBSERVE`, `STRICT → ENFORCE`, `DISABLED` unchanged. Both enum keys and string values change. Breaking change, but merchant count is small and we're in direct contact with all of them. Better than translating between vocabularies forever.

### Blocker 3 — Action state

Today the SDK collapses two distinct outcomes into `ALLOW`: human traffic that passed through, and bot traffic in soft mode that got let through with a signal header. Analytics needs to tell them apart.

**Decision: `HandlerAction` becomes three-state — `ALLOW | OBSERVE | BLOCK`.** Bundled into the same major version bump as the enum rename. One painful migration, not two.

---

## Step 3 — Schema corrections

With the three blockers settled, the smaller schema decisions fell out:

- `final_action` enum drops `challenge`. New values: `allow | observe | block`. (Challenge was a JS-Turnstile-style notion we don't actually do.)
- `token_outcome` enum gains `invalid_issuer` and `server_error`. Cheap to include now, expensive to retrofit later.
- `enforcement_mode` and `bot_detector_result` enums unchanged. `verified_bot` is reserved but unreachable in v1 (current detector returns `bool` — only a future server-side verifier like CAP or HTTP Message Signatures can populate it).
- Sorting key, partition key, engine, TTL: unchanged in intent. (TTL expression had a latent bug — `DateTime64` doesn't work in TTL clauses — fixed during deployment.)

The pipe (`traffic_summary.pipe`) needed no changes. It references enum values by string and only `challenge` was removed, which the pipe doesn't filter on.

---

## Step 4 — SDK implementation plan

Sent to Claude Code with the brief: produce a written plan first, wait for approval before coding. That instruction prevented a thousand-line diff from landing for review.

The plan covered:

- New files: `analytics/types.ts`, `analytics/buildAnalyticsEvent.ts`, `analytics/ip.ts`, `analytics/transport.ts`, plus tests.
- Modified files: `types.ts` (enum renames, three-state `HandlerAction`, new config fields), `bots.ts` (`BotVerdict` return type), `license.ts` (`buildSignalResult` returns `OBSERVE`), `cdn.ts` (per-CDN context bag with `sourceCdn` + `clientIp`), `index.ts` (wire `emitAnalyticsEvent` into all branches), `package.json` (1.4.1 → 2.0.0).
- Untouched: billing path (`recordEvent`, `verifyAndRecordEvent`), customer auth, JWKS, headers utility.

Seven ambiguities flagged in the plan, all answered:

1. `token_outcome` mapping for SDK reasons that don't 1:1 the schema → collapse `INVALID_HEADER / INVALID_PAYLOAD / INVALID_ALG` to `malformed`, `MISSING_TOKEN` to `absent`, leave `invalid_resource` unused for v1.
2. Tinybird region → workspace is `europe-west2.gcp.tinybird.co`.
3. Empty `client_ip` handling → emit `'::'` sentinel, no schema change.
4. Default enforcement mode → stays `OBSERVE` (renamed from `SOFT`), behavior unchanged.
5. Feature flag → emit iff `analyticsEnabled === true && analyticsToken set`. Warn at construction, not per request.
6. `handleRequest` signature → hard break, no overload. Major version anyway.
7. Create `CHANGELOG.md` at repo root.

Plan approved, implementation proceeded.

---

## Step 5 — Tinybird schema deployed

Schema files updated and `tb build` validated. Surfaced one pre-existing bug:

- `ENGINE_TTL "timestamp + INTERVAL 90 DAY"` fails because `DateTime64` columns aren't supported in TTL expressions. Fixed to `toDateTime(timestamp) + toIntervalDay(90)`. Same 90-day window, valid expression.

This was a latent bug from the original schema — it had never been validated against `tb build` before. Worth knowing for any future schema work: validate locally before declaring schemas "done."

---

## Step 6 — End-to-end testing plan

Decision: test in three layers, not all at once.

1. **Tinybird in isolation** — curl one synthetic event, query `traffic_summary`, confirm round-trip without the SDK in the loop. Catches schema-vs-payload bugs early.
2. **SDK unit tests** — `buildAnalyticsEvent` and `transport` tests with mocked fetch. Confirms the SDK constructs and attempts to send correctly.
3. **End-to-end against real Tinybird** — Node harness instantiates the SDK, mock `Request`, observe row in `bot_events_raw`. Test all five decision branches (allow/observe/block × token-present/no-token/bot-detector states).

Verifications added beyond the obvious:

- Check `bot_events_raw_quarantine` after every scenario. Schema mismatches land there silently — Events API still returns 202.
- For at least one event, `SELECT *` and eyeball every column. Catches fields that are silently empty (e.g. `accept_language` not making it through).
- Read-isolation test as a separate harness file: two synthetic merchants, two READ JWTs each bound to one merchant_id via `fixed_params`, verify each token only sees its own rows.

CDN choice for first realistic test: Cloudflare Workers via `wrangler dev` once the Node harness validates the basics. Fastly and CloudFront come later.

---

## Step 7 — Tinybird's write-token model breaks Option 3

This is where the design changed.

Claude Code went to mint the local append token and surfaced a fact the original Tinybird setup doc had wrong: **Tinybird JWTs only support `PIPES:READ` and `DATASOURCES:READ` scopes. `fixed_params` is read-side only.**

Concretely:

- There is no JWT that carries `DATASOURCES:APPEND` scope.
- The Events API at `POST /v0/events?name=...` does not consult `fixed_params` on its token. It accepts whatever `merchant_id` value is in the JSON body.
- This is true on both local and cloud — not a `tb --local` limitation.

What this kills:

- **Write-side multi-tenancy enforcement was the entire architectural justification for Option 3.** Without it, any merchant who has any append token can POST events tagged with any `merchant_id`. Tinybird won't stop them.

What still works:

- **Read-side isolation works exactly as designed.** Each merchant's read JWT is bound to their `merchant_id` via `fixed_params`. The pipe substitutes that value into `WHERE merchant_id = {{...}}` regardless of what the merchant passes. They literally cannot see another merchant's data.

So the *visible* multi-tenancy boundary is intact. The *write-side integrity* guarantee is gone.

Three options surfaced:

- **(a) Per-merchant append tokens** — narrows the leak blast radius to one merchant per token. Doesn't actually prevent spoofing; the token still doesn't constrain `merchant_id`.
- **(b) Backend relay** — SDK → backend (auth via API key) → Tinybird (auth via service token, `merchant_id` stamped server-side). Fully solves spoofing. Reintroduces the operational complexity Option 3 was meant to avoid.
- **(c) Trust the SDK on writes, accept that cross-tenant pollution is invisible thanks to read-side enforcement.** Pragmatic. Spoofed rows exist but no merchant can ever see them.

---

## Step 8 — Two real problems Claude Code untangled

Beyond the multi-tenancy question, Claude Code surfaced a second issue that had been hidden inside the first.

**Problem 1: How does the SDK know `merchant_id`?**

Today's SDK conflates `apiKey` and `merchant_id` — it just stamps the apiKey string as `merchant_id` on every event.

This is wrong even in a perfectly trusting world:

- `apiKey` is a credential — secret, rotatable.
- `merchant_id` is an identifier — stable, not secret.

If a merchant rotates their `apiKey`, every analytics row written before the rotation has `merchant_id = "old_key_value"` and every row after has `merchant_id = "new_key_value"`. From the dashboard's perspective, that's two different merchants. Their historical data is orphaned.

This is independent of the spoofing problem.

**Problem 2: How do we prevent a merchant from spoofing another's `merchant_id`?**

This is the multi-tenancy problem from Step 7. Tinybird can't enforce it on the write path. Solving it requires (a), (b), or (c) above.

---

## Step 9 — Decision: defer (b), but fix (1) now

Backend relay (option b) is the right long-term fix. The original "no backend relay" rule was based on a security guarantee that doesn't exist with Tinybird as a primitive — that justification evaporates the moment write-side `fixed_params` doesn't work. The existing `/events` billing flow already proxies through `api-connect.supertab.co`, so the operational pattern isn't new; an analytics-only relay (separate service, separate scaling) avoids degrading the billing path.

But the priority right now is finishing the v1 flow end-to-end, not solving every edge case. So:

**Decision: defer the backend relay. Fix the `apiKey === merchant_id` conflation now.**

Rationale: the conflation isn't a security problem — it's a data correctness problem. Even with no malicious merchants, key rotation orphans historical analytics rows. Fixing it is a small, contained SDK change. Deferring it bakes a subtle bug into the data shape that gets harder to fix the more rows accumulate.

Concretely:

- SDK gets a new explicit `merchantId` config field. Required. No fallback to `apiKey`.
- `buildAnalyticsEvent` uses `merchantId`, not `apiKey`.
- When backend relay eventually ships, `merchantId` moves out of SDK config — backend will derive it from `apiKey` lookup. The SDK becomes simpler, not more complex.

Known limitations accepted for v1:

- Write-side multi-tenancy enforced by trust, not by Tinybird.
- Read-side isolation via `fixed_params` works correctly.
- Documented in SDK README under "Known Limitations" with a reference to the eventual fix.

---

## Step 10 — Phase 1 testing complete

The Node harness and read-isolation test both passed. End-to-end ingestion proved out locally.

**Write-side harness (`scratch/local-emit.ts`):** SDK constructs an event, `HttpAnalyticsTransport` POSTs to local Tinybird, row appears in `bot_events_raw`. Six scenarios covered (allow/observe/block × token-present/no-token/bot-detector states). `_quarantine` stayed empty.

**Read-isolation harness (`scratch/read-isolation.ts`):** four assertions, all passed.

- Token A bound to `ri_alpha_*` via JWT `--fixed-params`: sees exactly its 3 rows.
- Token B bound to `ri_beta_*`: sees exactly its 5 rows.
- Override probe: Token A appended `?merchant_id=ri_beta_*` to the URL. Tinybird silently ignored the URL value and returned Token A's 3 rows. JWT `fixed_params` won.
- Stability: Token B's count unchanged on a second query.

Read-side multi-tenancy works as designed. A merchant given a JWT with `--fixed-params merchant_id=<their_id>` cannot escape that binding by passing a different value in the URL. This is the read-side counterpart to the write-side trust limitation documented in Step 9.

**Artifacts in place:**

- `scratch/local-emit.ts` — write-side end-to-end harness
- `scratch/read-isolation.ts` — read-side multi-tenancy harness
- `tinybird/tinybird/pipes/merchant_event_count.pipe` — minimal helper pipe used only by the read-isolation test (open question whether it ships as a permanent test fixture or moves under a `_test/` namespace)

**Outstanding from Phase 1:**

- PR description draft for the SDK v2.0 changes
- Decision on `merchant_event_count.pipe` namespacing

---

## Step 11 — Bot enforcement model: clarification

A reframing surfaced that hadn't been written down clearly: **the SDK's `botDetector` is enforcement-shaped, not identification-shaped.** Identification belongs in the warehouse. This was always the implied direction but had been muddled by the v1 SDK's existing `botDetector` returning a verdict.

The eventual model is three separated concerns:

- **Identification** — "this UA contains GPTBot" → warehouse, query-time, via `bot_ua_patterns`.
- **Classification** — "GPTBot is in the `ai_training` category" → warehouse, table-driven, editorial.
- **Enforcement** — "I want to block AI training bots, allow search indexers" → SDK, real-time, merchant policy.

The flow merchants will eventually live with:

1. Merchant deploys SDK in observe mode — every request emits an analytics event, no enforcement.
2. Tinybird classifies via `bot_ua_patterns` — merchant sees their actual bot traffic in the dashboard, broken down by bot/category.
3. Merchant decides — "block GPTBot, allow Googlebot, observe Perplexity" — based on what they actually see.
4. Decisions persist in the backend — a per-merchant policy table.
5. SDK loads the policy and enforces it at the edge.

The SDK isn't doing identification *or* detection. It's doing **policy lookup** — "incoming UA matches a known signature in this merchant's blocklist → block."

**Real-time enforcement still requires pattern matching at the edge.** The warehouse can't be queried per request. But the SDK doesn't need to know what *kind* of bot it's looking at, only whether the UA matches one of the merchant's policy rules. The pattern data ships to the SDK at init or via periodic refresh; identification taxonomy stays in the warehouse.

**Implications for current work:**

- The `defaultBotDetector` and `BotVerdict` return type are transitional. They exist for the v1 case where merchants haven't built policies yet. Once policy-based enforcement ships, this code path becomes either dead or a fallback.
- The `bot_detector_result` field on the event is misnamed for the long-term model. Under the policy framing, it should reflect "did the SDK match a policy rule?" rather than "what kind of bot is this?" Don't rename now; flag for future.
- The "run `botDetector` on token-present path" follow-up is **dropped**. Identification on token-present rows happens at query time in `traffic_summary` against `user_agent`, which is already captured. The SDK doesn't need to participate.
- The Phase 4 dashboard gains a *purpose* beyond just showing data — it's where merchants make policy decisions. For the MVP, show data only; the policy UI is later.

---

## Step 12 — MVP plan locked: Phases 2, 3, 4

Goal restated: end-to-end MVP working **locally**, not released. The SDK changes are too large for production. Three things must work in order:

- A real CDN (not just Node) emits events.
- Classification happens in Tinybird and is observably correct.
- A dashboard surface renders the labeled data via the eventual API.

After all three phases land, separate work begins on (a) covering all supported CDNs and (b) evaluating ingestion at scale (e.g. Fastly's native log streaming as an alternative `AnalyticsTransport`). Both are out of scope for the MVP.

### Phase 2 — Real CDN runtime (Cloudflare Workers via `wrangler dev`)

**Goal:** prove the SDK works in a real edge runtime, not just Node.

The Node harness validated `buildAnalyticsEvent` and the transport. It did *not* validate `ctx.waitUntil` actually firing the POST in a Worker runtime, `cf-connecting-ip` extraction from a real Workers `Request`, the `source_cdn: 'cloudflare'` path through `handleCloudflareRequest`, or whether the SDK even bundles into a Worker.

**What's needed:** throwaway Worker (`wrangler init`) importing the SDK, Worker secrets for `analyticsToken` and `merchantId`, local Tinybird still running, `analyticsEndpoint` pointed at `http://localhost:7181/v0/events?name=bot_events_raw`.

**Verification:** hit the Worker with curl using a few different UAs (one human, one GPTBot), confirm rows land in `bot_events_raw` with `source_cdn = 'cloudflare'` and correct `client_ip`, confirm `_quarantine` stays empty.

**Likely gotchas:** SDK bundle size, Workers' subset of Web APIs vs Node's, `wrangler dev` outbound to localhost.

### Phase 3 — Classification

**Goal:** rows arrive with real `bot_label` values, not `unclassified`.

Right now the patterns table is empty (apart from the read-isolation test rows). The pipe runs the JOIN but everything resolves to `unclassified`.

**What's needed:** an operator script (~50 lines, Python `requests.post`) that pulls `ai.robots.txt`, maps each entry to a `bot_ua_patterns` row (`pattern`, `match_type: 'contains'`, `bot_label`, `bot_category: 'ai_training'`, sequential `pattern_id`, `is_active: true`, `updated_at`), POSTs as NDJSON to the local Events API. Optional: hand-curated entries for major search bots (Googlebot, Bingbot).

**Verification:** query `bot_ua_patterns` directly to confirm ~50 rows, re-run a few harness scenarios with bot UAs (GPTBot, ClaudeBot), query `traffic_summary` and confirm `bot_label` returns the right value.

**Decisions made along the way:** what `bot_category` values to use (`ai_training`, `ai_assistant`, `search_indexer`, `scraper` to start), and the convention that specific patterns get lower `pattern_id` than generic ones so `argMin` picks the specific label when both match.

### Phase 4 — Dashboard surface (Option β)

**Goal:** validate the read-side API path that an eventual real dashboard will use, without coupling to any in-flight frontend work.

**Option chosen: β — tiny standalone HTML/JS page.** Tests the APIs that will eventually power the merchant dashboard. No integration into the actual Supertab dashboard yet. (Option α — Tinybird's auto-generated UI — was rejected because it skips the read-JWT integration. Option γ — wire into the existing merchant dashboard — was rejected as scope creep onto a frontend project still in motion.)

**What's needed:** a small backend endpoint (or local script) that mints a per-merchant read JWT against `traffic_summary` with `fixed_params: {merchant_id: ...}`, plus a single `dashboard.html` with vanilla JS or React that fetches `traffic_summary` with the JWT and renders bot traffic by hour and by `bot_label`. Merchant-swap dropdown for testing.

**Verification:** Token A's view shows only Token A's data (read-isolation in the actual UI path), pattern updates in `bot_ua_patterns` are visible in the dashboard within seconds, the bot-categories breakdown looks like something a merchant could act on.

**The "five merchant questions" conversation** from the build plan should happen before or during this phase. Make a best-guess list and iterate; with real synthetic data flowing the conversation gets sharper.

### Strict ordering

Phase 2 → Phase 3 → Phase 4. No parallelization. Each phase verifies a different layer; debugging two layers at once is what slowed earlier steps down.

### After the MVP

Out of scope, but on the radar:

- **All-CDNs pass** — repeat Phase 2 for Fastly Compute and CloudFront / Lambda@Edge. Same SDK code path, same `HttpAnalyticsTransport`.
- **Ingestion-at-scale evaluation** — replace the per-request HTTPS POST with native primitives where they win. Fastly log streaming is the headline candidate (out-of-band, free for the merchant, batched by Fastly). CloudFront standard logs to S3 + Tinybird connector for the cheap path. The `AnalyticsTransport` abstraction in the SDK exists specifically to make this swap painless.

---

## Where we are now

**Done:**

- Tinybird schema deployed with corrected enums (`final_action` three-value, `token_outcome` with `invalid_issuer` + `server_error`) and TTL fix.
- SDK v2.0 implementation built: enum renames, three-state `HandlerAction`, `request_id` generation, per-CDN `source_cdn` and `client_ip` extraction, flat header fields, `BotVerdict` return type, `AnalyticsTransport` interface, `HttpAnalyticsTransport`, feature flag, explicit `merchantId` config field, three breaking changes documented in CHANGELOG.
- Phase 1 testing complete: write-side end-to-end harness passing 6 scenarios; read-isolation harness passing 4 assertions.

**Current step: Phase 2 — Cloudflare Worker via `wrangler dev`.**

**Remaining MVP phases:** Phase 3 (seed `bot_ua_patterns` from `ai.robots.txt`, see classification working), Phase 4 (Option β standalone dashboard HTML).

**Outstanding from Phase 1:**

- PR description draft for the SDK v2.0 changes.
- Decision on `merchant_event_count.pipe` — permanent test fixture or move to `_test/` namespace.

**Deferred (with intent to come back):**

- Backend relay for write-side multi-tenancy hardening. Trigger: before any merchant onboarding beyond friendly partners, before any external security review.
- Pattern priority column on `bot_ua_patterns`. Trigger: first editorial conflict (multiple patterns matching the same UA with different labels).
- Materialized rollup for `traffic_summary` performance. Trigger: when query latency at real merchant volume exceeds the dashboard SLO. (See concept summary further below.)
- Native CDN log transports (Fastly log streaming, CloudFront → S3 → Tinybird). Trigger: after the all-CDNs MVP pass; replaces `HttpAnalyticsTransport` per CDN where the win justifies the work.
- `bot_detector_result` field rename. Under the enforcement model in Step 11, this field is misnamed. Defer until policy-based enforcement is closer.
- Policy-based enforcement (the eventual replacement for `defaultBotDetector`). Out of scope for the MVP entirely; on the roadmap as the long-term direction.

**Dropped:**

- Run `botDetector` on token-present path. Reason: Step 11 reframing — identification is a warehouse concern, not an SDK concern. The data needed for "which bots are in my licensed traffic" is already in `user_agent` and resolves at query time.

**Open questions:**

- `merchant_event_count.pipe` namespacing.
- Whether the eventual backend relay runs as a separate service or extends the existing `/events` handler. Lean: separate service so analytics traffic bursts don't degrade billing.

---

## Concepts to remember

### Materialized rollups

A pre-computed summary table. Instead of running the same expensive query every time someone opens the dashboard, the system computes it once when data arrives and stores the result.

Today, `traffic_summary` runs on every dashboard load: scan `bot_events_raw` for the merchant's rows in the time window, JOIN against `bot_ua_patterns`, group by hour, return ~24 rows. If a merchant has 1M events in the window, that's 1M rows scanned per refresh.

A materialized view would change this: as each new event arrives in `bot_events_raw`, the MV automatically runs the JOIN and writes one row to a `bot_events_classified` table with the bot label already resolved. A separate rollup table (`bot_events_hourly`) aggregates that into hourly buckets. The dashboard queries the rollup directly — 24 rows scanned instead of 1M.

**Why not now:** at synthetic test volume, the expensive query runs in milliseconds. Tinybird setup explicitly said don't build rollups until measured necessary, and that's correct.

**The catch:** materialized views are insert-time triggers. They process each row exactly once, when it arrives. Pattern updates only affect new traffic — events that arrived yesterday keep yesterday's labels (or no labels). The current schema avoids this by classifying at *query time*, so pattern updates immediately reclassify everything including history.

**Escape hatch when MVs become necessary:** keep `bot_events_raw` immutable and pattern-free, use a periodic `INSERT INTO ... SELECT` job to refresh `bot_events_classified` weekly or on pattern updates. Slower than a true MV but preserves the ability to reclassify history.

---

## What this changes vs. the original docs

The two source docs (`analytics-mvp-build-plan.md`, `supertab-tinybird-setup.md`) remain valid as records of the intent at the time. Specific points that are now superseded:

- **Tinybird setup doc, "Architecture at a glance" section:** the implied direct-edge-to-Tinybird path with per-merchant JWT and `fixed_params` enforcement does not work for writes. Read-side enforcement still works as described and is verified (Step 10).
- **Tinybird setup doc, "Critical pipe details" section:** the bullet about `fixed_params` for read tokens is correct. The implied write-side equivalent does not exist.
- **Build plan, Phase 0 schema decisions:** `final_action` enum should have three values (`allow / observe / block`), not four.
- **Build plan, Phase 1 SDK section:** `EnforcementMode` enum is now `OBSERVE / ENFORCE / DISABLED` (renamed). `HandlerAction` is now three-state. `BotDetector` returns `BotVerdict`, not `bool`. The SDK now has explicit `merchantId` separate from `apiKey`.
- **Build plan, Phase 2 sequencing:** Tinybird passed the bar but only for read-side multi-tenancy. Write-side hardening is a known gap, not a Tinybird disqualifier.
- **Build plan, "what the SDK does" framing throughout:** the `botDetector` is enforcement-shaped, not identification-shaped (Step 11). Identification is a warehouse concern.

Future work on this should reference both the original docs (for intent) and this one (for what actually shipped).
