# Bot Traffic Analytics — MVP State

State as of 2026-04-30. Strategic / forward-looking companion to
`scratch/HANDOFF.md`. This file consolidates:

- where the MVP is positioned (locally working, not released)
- the phased plan (Phases 2/3/4) that takes it from here to a usable
  surface
- deferred work with their reactivation triggers
- dropped follow-ups, with the reasoning that killed them
- the long-term reframing of bot detection as policy lookup, which
  changes how today's code should be read

`HANDOFF.md` covers the file/code-level "what shipped." This file
covers everything else: why, what's next, and what we explicitly
decided not to do.

> **Source:** consolidated from `scratch/analytics-mvp-implementation-followup.md`
> (the wider chronological narrative) plus the as-built work captured in
> `HANDOFF.md`. The follow-up doc remains the canonical record of how
> decisions were reached; this doc is the action-oriented summary.

---

## Where we are

**Phase 1 — done.** SDK v2.0 built locally; the read-side multi-tenancy
test (`tests/e2e/read-isolation.ts`) verifies that JWT
`--fixed-params merchant_id=<id>` is honored and URL-parameter override
is silently ignored.

**Phase 2 — done.** Cloudflare Worker validated in `wrangler dev` against
local Tinybird. The analytics-pipeline harness
(`tests/e2e/cloudflare-e2e.ts`) walks **all six** SDK emission branches
in workerd (the production runtime) and asserts each lands a row with
correct `source_cdn` / `client_ip` / `bot_detector_result` /
`token_outcome` / `final_action` / `enforcement_mode`. Replaces the
earlier Node-only `local-emit.ts` (retired) and the original
three-scenario `cloudflare-e2e` (extended).

**Phase 2.5 — done.** Demo extended to mirror the production
two-Worker split (CAP + RSL) in a single local Worker, talking to a
local supertab-connect backend (port 8000) so license-token issuance and
verification are end-to-end. Enforcement tests now run against
`http://127.0.0.1:8788` with real ES256 license tokens issued by the
local backend, and Tinybird analytics fires alongside. Required one
small SDK change: `cloudflareHandleRequests` gained an `originUrl`
option so license validation can happen against the publisher URL while
pass-through fetch resolves to a separate origin process — a workaround
for the local loopback. Production deployments using Workers Routes can
ignore the option.

**Phase 3 — done.** `bot_ua_patterns` seeded with 171 hand-curated rows
(merge of `ai.robots.txt`, KnownAgents, and operator docs). `traffic_summary`
returns real `bot_label` values for known UAs and `unclassified` only for
genuinely unknown ones. The classification harness
(`tests/e2e/classification-e2e.ts`) covers seed sanity, 12 canonical UAs
end-to-end through the merchant pipe, and the band-convention disambiguation
test. Required two unanticipated changes to the Tinybird side, both detailed
in `HANDOFF.md` §3.4 and below in this doc.

**Phase 4 — next.** Tiny Option β dashboard against `traffic_summary`.

**Not for release yet.** The v2.0 SDK changes are too large to ship to
production. The MVP target is "end-to-end working locally" so we can
reason about real merchant behavior, not "v2.0 in npm registry." Release
discussion comes after Phase 4.

---

## How we got here, in one screen

The original ingest design (in `analytics-mvp-build-plan.md` and
`supertab-tinybird-setup.md`, which both predate this work) was
**Option 3: per-merchant Tinybird JWT with `fixed_params: {merchant_id}`,
distributed at onboarding, edge talks straight to Tinybird, backend
stays out of the request path.**

That design assumed Tinybird's `fixed_params` worked symmetrically on
reads and writes. It does not. **`fixed_params` is read-side only.**
JWTs cannot carry `DATASOURCES:APPEND` scope at all; the Events API
accepts whatever `merchant_id` the JSON body asserts.

Option 3 still works for **reads** (verified — see Phase 1). It does
**not** prevent a merchant from spoofing another merchant's
`merchant_id` on writes. Three options surfaced:

- **(a) Per-merchant append tokens.** Narrows leak blast radius; doesn't
  prevent spoofing.
- **(b) Backend relay.** SDK → backend → Tinybird, `merchant_id` stamped
  server-side. Solves spoofing fully. Reintroduces the operational
  complexity Option 3 was meant to avoid.
- **(c) Trust the SDK on writes.** Cross-tenant pollution invisible
  thanks to read-side enforcement. Pragmatic for v1.

**Decision: (c) for the MVP, (b) deferred but acknowledged as the
right long-term fix.** The README documents the limitation; the
`merchantId` SDK config field is explicitly transitional and will move
out of SDK config once the backend relay ships.

A second issue surfaced alongside the multi-tenancy gap: the SDK
conflated `apiKey` (rotatable credential) with `merchant_id` (stable
identifier). Even with no malicious merchants, key rotation orphans
historical analytics rows. Fixed in this PR — `merchantId` is now a
required, separate config field.

---

## Reframing: `botDetector` is enforcement, not identification

This is the single most important framing shift to internalize before
working on the SDK or the schema next.

**The eventual model has three separated concerns:**

| Concern | Lives in | When |
|---|---|---|
| **Identification** — "this UA contains GPTBot" | Warehouse (`bot_ua_patterns`) | Query time |
| **Classification** — "GPTBot is in `ai_training`" | Warehouse (`bot_ua_patterns`) | Editorial / query time |
| **Enforcement** — "block AI training bots, allow search indexers" | SDK | Real time at the edge |

**The merchant flow this enables:**

1. Merchant deploys SDK in observe mode — events emit, no enforcement.
2. Tinybird classifies via `bot_ua_patterns` — merchant sees their actual bot traffic in the dashboard, broken down by bot/category.
3. Merchant chooses — block GPTBot, allow Googlebot, observe Perplexity.
4. Decisions persist in the backend (per-merchant policy table).
5. SDK loads the policy and enforces it at the edge.

The SDK isn't doing identification *or* detection. It's doing
**policy lookup** — "incoming UA matches a rule in this merchant's
blocklist → block."

Real-time enforcement still requires pattern matching at the edge (the
warehouse can't be queried per request), but the SDK doesn't need to
know what *kind* of bot it's looking at — only whether the UA matches
one of the merchant's policy rules. The pattern data ships to the SDK
at init / via periodic refresh; the identification taxonomy stays in
the warehouse.

**What this means for today's v2.0 code:**

- `defaultBotDetector` and `BotVerdict` are **transitional**. They
  exist for the v1 case where merchants haven't built policies yet.
  Once policy-based enforcement ships, this code path becomes either
  dead or a simple fallback.
- The `bot_detector_result` schema field is **misnamed** for the
  long-term model. It should reflect "did the SDK match a policy
  rule?" not "what kind of bot is this?" Don't rename now — defer
  until policy-based enforcement is closer.
- The Phase 4 dashboard gains a **purpose** beyond just showing data:
  it's where merchants make policy decisions. For the MVP, show data
  only; the policy UI is later.

---

## Phase 2 — Real CDN runtime (Cloudflare Workers) — DONE

**Goal:** prove the SDK works in a real edge runtime, not just Node.

**As-built (Phase 2 core, three-scenario harness flow):**

- `demos/cloudflare/` repurposed as the Phase 2 harness target. SDK dep
  switched from npm (`^0.1.0-beta.19`) to `file:../..` so it tracks the
  local `dist/` build. Re-run `npm install` after every `npm run build`.
- `demos/cloudflare/.dev.vars` extended with `MERCHANT_ID`,
  `SUPERTAB_ANALYTICS_TOKEN` (workspace admin from `tb --local token ls`),
  and `SUPERTAB_ANALYTICS_ENDPOINT=http://localhost:7181/v0/events?name=bot_events_raw`.
- `demos/cloudflare/src/index.ts` calls the public
  `SupertabConnect.cloudflareHandleRequests(...)` — the CDN entry point that
  Phase 2 was meant to validate.
- `demos/cloudflare/origin.ts` — single publisher-origin script (port
  8789). Standalone-runnable for manual testing
  (`npx tsx demos/cloudflare/origin.ts`); `cloudflare-e2e.ts` imports its
  `startOrigin()` and owns its lifecycle for harness runs.
  (Phase 2.5 consolidated this — earlier there was a duplicate
  `scratch/cloudflare-origin.ts` for the harness; both ran on the same
  port and served the same role, so they were merged into the demo file.)
- **Closes HANDOFF §10.3** for Cloudflare specifically (Fastly/CloudFront
  demos are still on the old beta).

**CDN handler review:** no functional changes were needed. The
`AnalyticsTransport` interface was already the abstraction for the Tinybird
call, and `cloudflareHandleRequests` already plumbs `merchantId` /
`analyticsToken` / `analyticsEndpoint` / `analyticsEnabled` through to the
constructor. To swap the ingestion path later, implement a different
`AnalyticsTransport` and inject via `SupertabConnectConfig.analyticsTransport`.
A small follow-up — exposing `analyticsTransport` directly on the
`cloudflareHandleRequests` options object — is the only ergonomics gap;
filed as a non-blocking nice-to-have.

**Verification:**

- `tests/e2e/cloudflare-e2e.ts` — self-asserting harness modeled on
  `read-isolation.ts`. Hits the Worker via `fetch`, polls Tinybird via
  `/v0/sql`, asserts every relevant field. Per-run path prefix
  (`/cf-e2e-<runId>/...`) so reruns don't collide. Six scenarios cover
  every SDK emission branch (allow/observe/block × bot-detector states ×
  enforcement modes). Drives the Worker's per-request enforcement /
  bot-detection overrides via `X-Test-Enforcement` and
  `X-Test-Bot-Detection` headers (gated by `ALLOW_TEST_OVERRIDES=true`
  in `.dev.vars`).
- `_quarantine` confirmed empty (Tinybird errors with "Datasource not
  found" — that's the healthy state).

**Gotchas resolved:**

- *`wrangler dev` outbound to `localhost:7181`.* Wrangler 4.86 local mode
  (workerd) reaches `localhost` cleanly. No tunnel or alias needed.
- *`cf-connecting-ip` in local mode.* Wrangler **auto-injects** the header
  (default value `127.0.0.1`) when the curl omits it; explicit values
  override. The SDK's `clientIp` extraction works without manual setup.
- *SDK bundle.* `tsup` ESM build (~22 KB) bundles into workerd without
  warnings. No Web-API-subset issues hit.
- *Demo loopback.* `cloudflareHandleRequests` calls `fetch(request)` for
  ALLOW/OBSERVE, which loops the Worker URL back through the Worker —
  workerd crashes after the subrequest-depth limit. Initial workaround:
  rewrite the request URL inside the Worker to point at a stub origin
  before handing it to the SDK. That worked for Phase 2's three scenarios
  but broke license-token verification in Phase 2.5 (token `aud` no longer
  matched the rewritten URL → `insufficient_scope` 403). See Phase 2.5 for
  the SDK `originUrl` option that replaced the rewrite.

**Non-fatal log lines** observed in `wrangler dev` output (worth knowing
but irrelevant to Phase 2):

- `Invalid license JWT header: TypeError: …` — the SDK debug-logs the
  `jose` parse error on the malformed-token scenario. The 401 response
  and the analytics row both still land.
- `Failed to record event: <status>` — the *billing* path posts to
  `{SUPERTAB_BASE_URL}/events`. The demo now sets `SUPERTAB_BASE_URL` to
  `http://localhost:8000` and the Worker calls
  `SupertabConnect.setBaseUrl(env.SUPERTAB_BASE_URL)` on each request,
  so this hits the local supertab-connect backend (start it before
  `wrangler dev` if you want billing-side success too — analytics is
  independent and lands regardless).

---

## Phase 2.5 — Production-like local setup — DONE

**Why it exists:** the original Phase 2 harness only exercised three
scenarios (human / GPTBot / malformed JWT). None of them ran the
**valid-token** path. When enforcement tests started issuing real ES256
license tokens via the local supertab-connect backend, the URL-rewrite
workaround broke verification: token `aud` was bound to the publisher
URL but the SDK validated against the rewritten origin URL, returning
`insufficient_scope` 403.

**As-built:**

- **Demo Worker now mirrors the production two-Worker split** documented
  in `supertab-connect/backend/src/services/cdn/orchestrators/cloudflare/instructions/`:
  - `GET /license.xml` → proxies to
    `{SUPERTAB_BASE_URL}/merchants/systems/{MERCHANT_SYSTEM_URN}/license.xml`
    (mirrors `rsl_license.md`'s RSL Worker).
  - everything else → `SupertabConnect.cloudflareHandleRequests` (mirrors
    `cap_on_edge.md`'s CAP Worker).
  - Production runs these as two separate Workers behind two Worker
    Routes; locally they're collapsed into one fetch handler so a single
    `wrangler dev` covers both.
- **Local backend wired in.** `demos/cloudflare/.dev.vars` gained
  `SUPERTAB_BASE_URL=http://localhost:8000` and
  `MERCHANT_SYSTEM_URN=urn:stc:merchant:system:...`. The Worker calls
  `SupertabConnect.setBaseUrl(env.SUPERTAB_BASE_URL)` per request so JWKS
  fetches and the billing event-record path hit the local backend.
- **Publisher origin.** `demos/cloudflare/origin.ts` — single Node http
  server (port 8789) serving an HTML "publisher website" (homepage,
  `/articles/*`) plus a plain-text fallback for harness paths. Exports
  `startOrigin()` for the harness; standalone-runnable for manual
  testing. Phase 2.5 consolidated this file from a previous duplicate
  in `scratch/`.
- **Port re-alignment.** Worker = publisher URL = `:8788` (what tests
  hit, what tokens are bound to via `aud`). Origin = `:8789` (hidden
  behind the Worker). Backend = `:8000`. Tinybird = `:7181`. The Phase 2
  harness defaults updated to match (`WORKER_URL`, `ORIGIN_PORT` env
  overrides still supported).
- **SDK change — `cloudflareHandleRequests` `originUrl` option.**
  `src/cdn.ts:33` and `src/index.ts:437`. When set, license verification
  still uses `request.url` (so token `aud` matches the publisher URL)
  but ALLOW/OBSERVE pass-through fetches from `originUrl` instead.
  Path / query / method / headers / body are preserved. Production
  Cloudflare deployments using Workers Routes can omit it — the existing
  `fetch(request)` behavior is unchanged when the option isn't set.
  **Note:** the user has flagged this as "may revert" — purely a
  local-dev convenience. Two off-ramps if reverting:
  1. Drop `cloudflareHandleRequests` in the demo, do `verify` + manual
     `fetch(originUrl + path)` flow control in the Worker. ~30 lines of
     demo code; SDK stays clean.
  2. Run prod-mirror locally via `cloudflared` tunnel + `wrangler dev
     --remote` against a real Cloudflare zone. No SDK or demo change
     needed; trade is "tunnel infra + slower iteration."
- **Analytics opt-in.** Worker now reads
  `analyticsEnabled: !!env.SUPERTAB_ANALYTICS_TOKEN`. Remove the token
  from `.dev.vars` to skip Tinybird; keep it set to emit. Verified
  end-to-end: a probe request lands a row in `bot_events_raw` with
  `source_cdn=cloudflare`, correct path, `cf-connecting-ip`-extracted
  client_ip.

**Verification:**

- Enforcement tests run against `http://127.0.0.1:8788` with real
  license tokens issued by the local backend. `aud` matches; SDK
  verifies tokens via JWKS at `http://localhost:8000/.well-known/jwks.json/platform`.
- `curl http://127.0.0.1:8788/license.xml` returns the RSL XML proxied
  from the local backend.
- Tinybird row landed and queryable on a live probe.

### Resume cheatsheet (current state)

```bash
# 0. Confirm SDK build is current
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript && npm run build
cd demos/cloudflare && npm install   # re-resolves file:../.. link after a rebuild

# 1. Local supertab-connect backend (port 8000)
cd /Users/hassaanelgarem/supertab/supertab-connect && docker compose up backend
# health: curl -s http://localhost:8000/.well-known/jwks.json/platform | head -c 200

# 2. (Optional — only for analytics) Tinybird Local
cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird && tb dev
# health: curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7181/v0/health  → 200

# 3. Publisher origin on :8789 (skip if you'll use the harness — it starts its own)
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript
npx tsx demos/cloudflare/origin.ts

# 4. Worker on :8788 (publisher URL)
cd demos/cloudflare && npx wrangler dev --port 8788 --ip 127.0.0.1

# 5a. Manual probe: curl / browser → http://127.0.0.1:8788/  or  /license.xml

# 5b. Phase 2 self-asserting harness (analytics rows)
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript
TB_ADMIN_TOKEN=$(cd ../supertab-connect/tinybird && tb --local token ls | awk '/^name: workspace admin token/{getline; print $2}') \
  npx tsx tests/e2e/cloudflare-e2e.ts

# 5c. Worker HTTP behavior tests (vitest):
npm test                                       # all *.test.ts
# OR specifically:
npx vitest run tests/e2e/enforcement.test.ts
```

The merchant system's `base_url` in the local backend must equal the
Worker URL (`http://127.0.0.1:8788`) — that's what gets stamped into
license token `aud`, and what the SDK validates against. If the local
Tinybird workspace was rebuilt, refresh `SUPERTAB_ANALYTICS_TOKEN` in
`.dev.vars` from `tb --local token ls` (workspace admin token).

---

## Phase 3 — Classification — DONE

**Goal:** rows arrive with real `bot_label` values instead of `unclassified`.

**As-built:**

- `tinybird/seed_bot_ua_patterns.ndjson` — 171 hand-curated rows. Hand-merged
  from three sources: `ai.robots.txt`, Cloudflare's KnownAgents list, and
  per-vendor operator docs. Categories landed at 9 values, not 4 as
  originally sketched: `ai_training`, `ai_assistant`, `ai_search`, `ai_agent`,
  `search_indexer`, `page_preview`, `archiver`, `seo_tool`, `scraper`. The
  AI surface has more shape than "training vs assistant" once you look at
  what operators actually publish (search bots, agent runtimes, deep-research
  fetchers, etc.).
- **Band convention** (also encodes priority — lower `pattern_id` wins via
  `argMin`): 1–199 specific AI, 200–499 search, 500–599 page preview,
  600–699 archiver, 700–899 SEO, 900–999 lib/dev tooling, 1000+ generic
  catch-alls. Specific patterns must always sit below the generics that
  could also match them.
- `tests/e2e/seed-bot-ua-patterns.ts` — idempotent NDJSON ingest. Reads the
  fixture, stamps `updated_at = now()`, POSTs to the Events API. Re-runs
  just bump `updated_at` and the `ReplacingMergeTree` collapses on
  `pattern_id` at read time (`SELECT ... FROM bot_ua_patterns FINAL`).
- `tests/e2e/classification-e2e.ts` — three blocks: (a) seed count matches
  NDJSON line count, (b) 12 canonical UAs (GPTBot / ChatGPT-User / ClaudeBot /
  Claude-User / PerplexityBot / Googlebot / Bingbot / facebookexternalhit /
  AhrefsBot / CCBot / Bytespider / a Safari UA expected to be `unclassified`)
  routed through the real `traffic_summary` pipe for label assertions and
  through a direct `argMin(_, pattern_id)` query against `bot_ua_patterns`
  for category assertions, (c) disambiguation — `Mozilla/5.0 (compatible;
  GPTBot/1.1; ...)` resolves to `GPTBot` (id=1), not `generic-bot` (id=1003).
  Per-run `merchant_id` prefix so reruns don't collide.

**Two Tinybird changes this surfaced** (also in `HANDOFF.md` §3.4):

1. **`bot_ua_patterns.datasource` — added JSONPaths.** The original schema
   omitted `json:$.field` annotations, so Tinybird treated the datasource
   as CSV-only and rejected NDJSON ingest. Same fields, types, and engine —
   purely metadata. The Phase 3 plan implicitly assumed JSONPaths existed
   (it specified "POST as NDJSON to the local Events API"); they didn't.
2. **`traffic_summary.pipe` — `classified_events` node restructured.** The
   original `LEFT JOIN bot_ua_patterns ON (OR-chain of non-equi match-type
   predicates)` is rejected by ClickHouse (`Cannot determine join keys`),
   regardless of whether patterns are seeded. The setting that allows it
   (`allow_experimental_join_condition`) is restricted on Tinybird. The
   earlier HANDOFF claim that "this works once patterns are seeded" was
   wrong — the pipe had simply never been exercised. New shape: a `matched`
   CTE pre-classifies via `CROSS JOIN + WHERE` grouped by `request_id`,
   then an equi-`LEFT JOIN` from events resolves to either the winning
   label or `'unclassified'` (via an `is_matched` flag column, since CH
   defaults missing-side String values to `''` not `NULL` on `LEFT JOIN`,
   which would have defeated `coalesce`). Output schema unchanged.

**What's still deferred (tracked in "Deferred work" below):**

- Automated `ai.robots.txt` diff/sync — manual additions for now.
- KnownAgents API integration — hand-cross-referenced for now.
- Pattern priority column on `bot_ua_patterns` — band convention is
  doing the priority work today; revisit on first editorial conflict.

**Verification:**

- `tests/e2e/seed-bot-ua-patterns.ts` — passes, idempotent on re-run.
- `tests/e2e/classification-e2e.ts` — all assertions pass.
- `tests/e2e/read-isolation.ts` — still passes after the schema/pipe changes.
- `tests/e2e/cloudflare-e2e.ts` — not re-run during Phase 3 (needs wrangler
  dev + local backend). It only queries `bot_events_raw` via `/v0/sql`, so
  the JSONPaths and `traffic_summary` rewrites should not affect it; worth
  a manual confirmation on the next CDN session.

---

## Phase 4 — Dashboard (Option β)

**Goal:** validate the read-side API path that an eventual real
dashboard will use, without coupling to in-flight frontend work.

**Option chosen: β — tiny standalone HTML/JS page.**

- Option α (Tinybird's auto-generated UI) — rejected, skips the read-JWT integration
- Option γ (wire into existing merchant dashboard) — rejected as scope creep onto a frontend project still in motion

**What's needed:**

- A small backend endpoint (or local script) that mints a per-merchant read JWT against `traffic_summary` with `fixed_params: {merchant_id: ...}`
- A single `dashboard.html` with vanilla JS (or React) that:
  - Fetches `traffic_summary` with the JWT
  - Renders bot traffic by hour and by `bot_label`
  - Has a merchant-swap dropdown for testing isolation in the UI

**Verification:**

- Token A's view shows only Token A's data (read-isolation in the actual UI path)
- Pattern updates in `bot_ua_patterns` are visible in the dashboard within seconds
- Bot-categories breakdown looks like something a merchant could act on

**Adjacent conversation:** the "five merchant questions" exercise from
the build plan should happen before or during this phase. With real
synthetic data flowing, the conversation gets sharper.

---

## Strict ordering

**Phase 2 → Phase 3 → Phase 4. No parallelization.** Each phase
verifies a different layer; debugging two layers at once is what slowed
earlier steps down.

---

## Deferred work (with reactivation triggers)

| Item | Trigger to revisit |
|---|---|
| **Backend analytics relay** | Before any merchant onboarding beyond friendly partners; before any external security review. Replaces the current write-side trust assumption. When it ships, `merchantId` moves out of SDK config (becomes backend-derived). |
| **Pattern priority column on `bot_ua_patterns`** | First editorial conflict — multiple patterns matching the same UA with different `bot_label` values. Phase 3 uses the `pattern_id` band convention (lower wins via `argMin`) to encode priority implicitly; an explicit column is the next step when that's no longer enough. |
| **Automated `ai.robots.txt` diff/sync** | When the manual cadence of adding bots from upstream changelogs becomes a bottleneck. Phase 3 ships a 171-row hand-curated seed; new entries today require a human edit + re-running `tests/e2e/seed-bot-ua-patterns.ts`. |
| **KnownAgents API integration** | Same trigger as ai.robots.txt sync. Phase 3 hand-cross-references; automate when manual upkeep stops scaling. |
| **Regex-pattern support in the harness's `winningPattern` query** | When the seed gains its first `match_type='regex'` row. Today the seed has zero regex patterns and the harness's direct-argMin SQL omits the regex branch (ClickHouse rejects `match()` with constant haystack + column needle). Real `traffic_summary` handles regex fine because there both sides are columns. |
| **Materialized rollup for `traffic_summary`** | When query latency at real merchant volume exceeds the dashboard SLO. See "Concepts" below for the catch. |
| **Native CDN log transports** (Fastly log streaming, CloudFront → S3 → Tinybird connector) | After the all-CDNs MVP pass. Replaces `HttpAnalyticsTransport` per CDN where the operational win justifies the work. The `AnalyticsTransport` interface in the SDK exists specifically to make this swap painless. |
| **All-CDNs MVP pass** (Fastly + CloudFront after Cloudflare) | After Phase 4 lands. Same SDK code paths, same `HttpAnalyticsTransport`. |
| **`bot_detector_result` field rename** | When policy-based enforcement is closer. Field is misnamed for the long-term model — see "Reframing" above. |
| **Policy-based enforcement** (eventual replacement for `defaultBotDetector`) | Long-term roadmap item. Not part of MVP. The SDK's eventual job is policy lookup, not bot detection. |
| **Periodic "unknown enum values" sanity query** | Compensates for Tinybird's lost enum validation (we use `LowCardinality(String)` instead of `Enum8` because JSONPaths doesn't accept `Enum8`). Small pipe that counts unexpected values per enum-shaped column. |

---

## Dropped follow-ups (with reasons)

These were considered and explicitly killed. Recorded so they don't get
re-raised in a future chat without context.

| Item | Reason |
|---|---|
| **Run `defaultBotDetector` on the token-present path** to populate analytics | Identification belongs in the warehouse, not the SDK. The `user_agent` is already captured on every event; classification resolves at query time via `bot_ua_patterns`. The SDK doesn't need to participate. (Originally surfaced as "analytics rows for licensed requests always have `bot_detector_result: 'unknown'`, isn't that wrong?" — under the policy-vs-detection reframe, it isn't wrong, the field is just misnamed.) |

---

## Open questions

- **`merchant_event_count.pipe` namespacing.** It's currently in
  `tinybird/tinybird/pipes/` next to production pipes. Decide before
  the PR ships: keep there with a clear naming convention, or move to
  a `_test/` or `_fixtures/` namespace.
- **Backend analytics relay shape.** Separate service, or extension of
  the existing `/events` handler? Lean: **separate service**, so
  analytics traffic bursts can't degrade the billing path. Decision
  not needed until the relay is actually being built.

---

## Concepts to remember

### Materialized rollups and why we don't have one yet

A materialized view is a pre-computed summary table. Instead of running
the same expensive query every time someone opens the dashboard, the
system computes it once when data arrives and stores the result.

**Today:** `traffic_summary` runs on every dashboard load — scan
`bot_events_raw` for the merchant's rows in the time window, JOIN
against `bot_ua_patterns`, group by hour, return ~24 rows. If a
merchant has 1M events in the window, that's 1M rows scanned per
refresh.

**With a materialized view:** as each new event arrives, the MV
automatically runs the JOIN and writes one row to a
`bot_events_classified` table with the bot label already resolved. A
separate rollup table aggregates that into hourly buckets. The
dashboard queries the rollup directly — 24 rows scanned, not 1M.

**Why not now:** at synthetic test volume, the expensive query runs in
milliseconds. The Tinybird setup doc was explicit: don't build rollups
until measurably necessary. That's still correct.

**The catch when we eventually need it:** materialized views are
insert-time triggers. They process each row exactly once, when it
arrives. **Pattern updates only affect new traffic.** Events that
arrived yesterday keep yesterday's labels (or no labels at all). The
current schema deliberately classifies at *query time* so pattern
updates immediately reclassify everything including history.

**Escape hatch when MVs become necessary:** keep `bot_events_raw`
immutable and pattern-free. Use a periodic
`INSERT INTO bot_events_classified SELECT ... FROM bot_events_raw JOIN bot_ua_patterns`
job to refresh weekly or on pattern updates. Slower than a true MV but
preserves the ability to reclassify history.

### Why the schema diverged from the original design

Tinybird's JSONPaths ingestion (the `json:$.field` annotations on each
column) supports a restricted type subset:

- Numerics, `String`, `FixedString`, `LowCardinality(String)`, `Date`, `DateTime`, `DateTime64`, `Bool`, arrays of those

Rejected:

- `Enum8(...)` — would require per-row enum-set validation in the hot ingest path
- `IPv6` — would require string→16-byte parsing in the hot ingest path

Result for `bot_events_raw`:

- `client_ip`: `IPv6` → `String`
- 4 enum-shaped columns (`final_action`, `token_outcome`, `bot_detector_result`, `enforcement_mode`): `Enum8(...)` → `LowCardinality(String)`

Trade-off accepted: lost Tinybird-side enum validation; kept compile-time validation at the SDK type layer (TS string-union types in `src/analytics/types.ts`). The "unknown enum values" deferred item exists to compensate.

---

## Quick navigation

- **`scratch/HANDOFF.md`** — what's actually built (file paths, config keys, commands to re-run)
- **`scratch/analytics-mvp-implementation-followup.md`** — chronological narrative of how decisions were reached
- **`tests/e2e/cloudflare-e2e.ts`** — analytics pipeline E2E (workerd, all 6 SDK emit branches; Phase 2/2.5)
- **`tests/e2e/read-isolation.ts`** — read-side multi-tenancy harness (Phase 1)
- **`tests/e2e/seed-bot-ua-patterns.ts`** — idempotent NDJSON seeder for `bot_ua_patterns` (Phase 3)
- **`tests/e2e/classification-e2e.ts`** — classification harness; seed sanity, canonical UAs, disambiguation (Phase 3)
- **`../supertab-connect/tinybird/tinybird/seed_bot_ua_patterns.ndjson`** — 171-row hand-curated UA pattern seed (Phase 3)
- **`../supertab-connect/tinybird/tinybird/seed_bot_ua_patterns.README.md`** — seed sources, band convention, addition workflow (Phase 3)
- **`tests/e2e/enforcement.test.ts`** — Worker HTTP behavior (vitest; user-driven)
- *(retired)* `scratch/local-emit.ts` — Node-only write harness, replaced by the workerd-based `cloudflare-e2e.ts` in the Phase 2.5 cleanup
- **`demos/cloudflare/origin.ts`** — publisher origin used by both the demo's manual flow and the Phase 2 harness
- **`demos/cloudflare/`** — Phase 2 Worker target. See its README for run instructions.
- **`scratch/merchant_event_count.pipe`** — minimal helper pipe used by the read-isolation harness
- Source docs that predate this work and are still partially valid:
  - `analytics-mvp-build-plan.md` (location TBD — referenced by the follow-up but not in `scratch/`)
  - `supertab-tinybird-setup.md` (same)
- **CHANGELOG.md** at the SDK repo root — v2.0.0 BREAKING bullets including `merchantId` requirement
- **README.md** at the SDK repo root — Configuration Options table + Known Limitations section
