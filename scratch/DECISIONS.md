# Bot Traffic Analytics — Decisions

> Chronological "why" behind the non-obvious calls. Open this when
> you're tempted to second-guess a past choice. For current state, run
> commands, file paths — see `STATE.md`.
>
> **Source docs that predate this work and partially survive in spirit:**
> `analytics-mvp-build-plan.md` (strategic intent — phased rollout, two
> pipelines, query-time classification) and `supertab-tinybird-setup.md`
> (concrete Tinybird shape). Both still useful as records of original
> intent, but several of their assumptions were superseded; specifically
> see Step 7 on the write-token model and Step 9 on `apiKey`/identifier
> separation.

---

## Where things stood at the start

The original ingest design was **Option 3: per-merchant Tinybird JWT
with `fixed_params: {merchant_id}`, baked at onboarding, edge talks
straight to Tinybird, backend stays out of the request path.** That
design assumed `fixed_params` worked symmetrically on reads and writes.
It doesn't (Step 7).

Three options surfaced when that assumption broke:
- **(a) Per-merchant append tokens** — narrows leak blast radius;
  doesn't prevent spoofing.
- **(b) Backend relay** — SDK → backend → Tinybird, identifier stamped
  server-side. Solves spoofing fully. Reintroduces operational
  complexity Option 3 was meant to avoid.
- **(c) Trust the SDK on writes** — cross-tenant pollution invisible
  thanks to read-side enforcement. Pragmatic for v1.

**Decision: (c) for the MVP, (b) deferred** as the right long-term fix.

---

## Step 1 — Schema review against the existing SDK

Before extending anything, the schema and SDK got cross-checked. The
gaps were real and numerous, and they shaped most of the v2.0 work:

- `request_id`, `source_cdn`, `client_ip`, flat `path`/`method`/`referer`/`accept_language`, explicit `has_token` — none populated by the SDK.
- Enum vocabulary mismatched. SDK used `SOFT / STRICT / DISABLED`; schema used `observe / enforce / disabled`.
- Bot detector returned `bool`. Schema expected a five-value enum.
- `final_action` schema had four values including `challenge`. SDK had two values plus an awkward "soft signal" path that returned ALLOW with a warning header.
- `token_outcome` enum was missing slots for `INVALID_ISSUER` and `SERVER_ERROR`.

These weren't blockers — they were the v2.0 work to be done. The
breaking changes that came out of this review (renames, three-state
`HandlerAction`, `BotVerdict` return type, expanded `token_outcome`
enum) are all in `CHANGELOG.md`.

---

## Step 2 — Three architectural blockers, settled in order

**Blocker 1 — Ingest path.** The original choice was direct
edge-to-Tinybird via per-merchant JWT (Option 3). This survived this
step but later broke (Step 7).

**Blocker 2 — Enum vocabulary.** The SDK and schema used different
names for the same concepts. Decision: the schema's vocabulary is the
canonical one (`observe / enforce / disabled`, `allow / observe /
block`, etc.). The SDK was renamed to match. This is why
`EnforcementMode.SOFT → OBSERVE` is a v2.0 BREAKING change.

**Blocker 3 — `BotDetector` return type.** The schema needed a
five-value enum, but the SDK was returning `bool`. Decision: change the
SDK's return type to `BotVerdict`. The third blocker felt like the
biggest API break at the time, but ended up being the cleanest — the
new shape was already what the schema needed.

---

## Step 7 — Tinybird's write-token model breaks Option 3

The `fixed_params` mechanism that Option 3 was built around is
**read-side only**.

- The Events API (`POST /v0/events?name=...`) does not consult
  `fixed_params` on its token. It accepts whatever `merchant_id` value
  is in the JSON body. (At the time the column was named `merchant_id`;
  see Step 13 for the rename.)
- JWTs cannot carry `DATASOURCES:APPEND` scope at all — that scope is
  static-token-only.
- Read-side isolation works exactly as designed (and is verified — see
  `tests/e2e/read-isolation.ts`).

Write-side multi-tenancy enforcement was the entire architectural
justification for Option 3. Without it, any merchant who has any
append token can POST events tagged with any other merchant's ID.
Tinybird won't stop them.

This was the "oh shit" moment that forced the (a) / (b) / (c) decision
to come back to the table.

---

## Step 8 — Two real problems

The Step 7 discovery surfaced two distinct issues that had been latent:

**Problem 1 — How does the SDK know its tenant identifier?** The SDK
was conflating `apiKey` and the analytics tenant ID — it was just
stamping the `apiKey` string as the identifier on every event.

- `apiKey` is a credential — rotatable, secret.
- The tenant ID is an identifier — stable, not secret.

If a merchant rotates their `apiKey`, every analytics row written
before the rotation has the old key as ID and every row after has the
new one. From the dashboard's perspective: two different merchants.
Their historical data is orphaned.

**Problem 2 — How do we prevent a merchant from spoofing another's
tenant ID on writes?** This is the Step 7 limitation, restated. Two
forks: backend relay (full fix, full operational cost) or trust (no fix,
no cost).

---

## Step 9 — Decision: defer (b), fix Problem 1 now

**Decision: defer the backend relay (Option (b) above). Fix the
`apiKey === tenant_id` conflation now.**

Rationale: the conflation is a real correctness bug right now (rotating
an `apiKey` orphans data). The spoofing risk is theoretical until we
have multiple merchants writing to the same workspace, and the read-side
enforcement makes it invisible to merchants even when it does happen.
The MVP can ship trust-based and the README documents the limitation;
the backend relay reactivates before any non-friendly-partner
onboarding.

What this added: a new explicit `merchantId: string` config field
(later renamed to `merchantSystemUrn` — see Step 13). Required. No
fallback to `apiKey`. When backend relay eventually ships,
`merchantSystemUrn` moves out of SDK config.

---

## Step 11 — Bot enforcement model is policy lookup, not identification

The single most consequential reframing. The eventual model has three
separated concerns: **identification** (warehouse), **classification**
(warehouse), **enforcement** (SDK). The SDK doesn't do identification
*or* detection in the long run — it does **policy lookup** ("does this
UA match a rule in this merchant's blocklist?").

The merchant flow this enables:

1. Merchant deploys SDK in observe mode — events emit, no enforcement.
2. Tinybird classifies via `bot_ua_patterns` — merchant sees their
   actual bot traffic in the dashboard, broken down by bot/category.
3. Merchant chooses — block GPTBot, allow Googlebot, observe Perplexity.
4. Decisions persist in the backend (per-merchant policy table).
5. SDK loads the policy and enforces it at the edge.

Real-time enforcement at the edge still requires pattern matching
(can't query the warehouse per request), but the SDK doesn't need to
know what *kind* of bot a UA is — only whether it matches one of the
merchant's policy rules.

**Implications for current code:**

- `defaultBotDetector` and `BotVerdict` are **transitional**. They
  exist for v1 where merchants haven't built policies yet. Once
  policy-based enforcement ships, this code path becomes either dead
  or a fallback.
- The `bot_detector_result` schema field is **misnamed** under the
  policy framing. It should reflect "did the SDK match a policy
  rule?", not "what kind of bot is this?" Don't rename now — defer
  until policy-based enforcement is closer.
- "Run `botDetector` on the token-present path so analytics rows
  aren't `bot_detector_result: 'unknown'`" was raised as a follow-up.
  **Dropped.** Identification is a warehouse concern; the
  `user_agent` is captured on every event; classification resolves at
  query time. The SDK doesn't need to participate.
- The Phase 4 dashboard gains a *purpose* beyond just showing data —
  it's where merchants make policy decisions. For the MVP, show data
  only; policy UI is later.

---

## Step 13 — Rename `merchantId` → `merchantSystemUrn`

While auditing the Phase 3 sign-off, two distinct issues with the
analytics identifier surfaced. They had been latent since Step 9 but
didn't get caught until Phase 3's seeded canonical data made the
inconsistency visible.

**Issue 1 — wrong noun.** The SDK config field was `merchantId`, but
the identifier stamped on every analytics row is a merchant *system*
URN. The Tinybird table is per-merchant-system, not per-merchant.
Worse: in the Supertab Connect backend, `merchant_id` means the parent
**Merchant** UUID — strictly *not* the merchant system. So the SDK
field was using a noun that meant something else upstream.

**Issue 2 — wrong shape.** The demo's `MERCHANT_ID` env var was set to
`merchant:system:<uuid>`. That half-URN exists nowhere else in the
system: backend canonical is either the bare UUID
(`merchant_system_id`) or the full URN
(`urn:stc:merchant:system:<uuid>` = `merchant_system_urn`). The
half-URN was an artifact of the original Phase-2 wiring, not a schema
decision.

**Decision: rename in this PR rather than defer.** v2.0.0 is
unreleased, so there are no production callers to keep compatible.
Folding the rename into the existing breaking-change set is cheaper
than shipping v2.0.0 with a known-misnamed field and renaming in v2.1.

What changed (full list in `CHANGELOG.md`):
- SDK config field `merchantId` → `merchantSystemUrn`.
- Cloudflare env `MERCHANT_ID` → `MERCHANT_SYSTEM_URN`.
- Demo `.dev.vars` collapsed two related vars into one (`MERCHANT_SYSTEM_URN` full URN), used for both analytics emission and license.xml proxy.
- Fastly options' discriminated union (RSL on/off requiring different fields) collapsed to a flat interface — URN is required for analytics on every request, reused for license.xml when `enableRSL: true`.
- Tinybird column `bot_events_raw.merchant_id` → `merchant_system_urn` (with matching JSONPath and sorting key). JWT minting binds `--fixed-params merchant_system_urn=<urn>`.
- Tests use URN-shaped synthetic IDs (`urn:stc:merchant:system:<run-id>`) so the column type matches intent end-to-end.

What did **not** change:
- The merchant-asserted-on-write trust assumption (Step 9). Only the
  field name moved. The backend relay (deferred) is the actual fix.
- `bot_detector_result`. Still misnamed under the Step 11 policy
  model. Rename still deferred until policy enforcement is closer.
