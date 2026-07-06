# End-to-End Tests

Both tests run the SDK inside a **real Cloudflare Worker** (`workerd` via
`wrangler dev`, the `demos/cloudflare` demo) in front of a local publisher origin.

| File | What it checks | Runner |
|------|----------------|--------|
| `enforcement.test.ts` | Worker HTTP behavior — status codes, headers, license verification — for the **mode the Worker is configured in** | vitest |
| `cloudflare-e2e.ts` | Analytics pipeline — **every** emit branch lands the right row in Tinybird (needs `ALLOW_TEST_OVERRIDES`; local/sandbox only) | standalone `tsx` |
| `analytics-smoke.ts` | Analytics rows land in Tinybird for a **deployed** Worker — prod-safe (no overrides), honors `ANALYTICS_ENABLED` | standalone `tsx` |

> The two analytics scripts share `tinybird-helpers.ts` — Tinybird query/poll
> plumbing (`createTinybirdClient`) and a ✓/✗ assertion tracker (`createExpect`).

## Which test when

- **Changed the SDK? Validate locally** → `enforcement.test.ts` + `cloudflare-e2e.ts`
  against `TEST_ENV=local-cloudflare` (the default).
- **Deployed a Worker (sandbox/prod)? Confirm it** → `enforcement.test.ts` (HTTP
  behavior in its real mode) + `analytics-smoke.ts` (rows actually land) against
  that env, e.g. `TEST_ENV=production-cloudflare`.

All three are keyed by **`TEST_ENV`** → `config.ts` (worker URL, backend, mode,
Tinybird host, merchant URN). The only thing passed separately is the secret
`TB_ADMIN_TOKEN` (for the analytics scripts to read Tinybird).

---

## Quickstart — validate SDK changes against local Cloudflare

Use this whenever you change the SDK and want to confirm it still behaves
end-to-end through a real Worker.

> **The #1 gotcha:** the demo depends on the SDK via `file:../..`, which resolves
> to the SDK's **built** output (`dist/`) — *not* `src/`. After editing SDK
> source you MUST rebuild and restart `wrangler dev`, or the Worker keeps running
> the old code. (`wrangler dev` also does **not** hot-reload `.dev.vars`.)

### 0. One-time setup

```bash
# e2e credentials (gitignored) — fill clientId/clientSecret for the local-cloudflare env
cp tests/e2e/config.example.ts tests/e2e/config.ts

# worker config (gitignored)
cd demos/cloudflare && cp .dev.vars.example .dev.vars && npm install && cd ../..
```

`demos/cloudflare/.dev.vars` for local should be:

```env
MERCHANT_API_KEY=<a key your LOCAL backend recognizes>
MERCHANT_SYSTEM_URN=urn:stc:merchant:system:<that key's system>
SUPERTAB_BASE_URL=http://localhost:8000
ORIGIN_URL=http://127.0.0.1:8789
ANALYTICS_ENABLED=true
ALLOW_TEST_OVERRIDES=true
```

### 1. Rebuild the SDK (after any SDK source change)

```bash
# from the SDK repo root
npm run build      # refreshes dist/, which the demo imports via file:../..
```

### 2. Bring up the stack (4 services)

| Port | Service | Command |
|------|---------|---------|
| 7181 | Tinybird Local | `cd ../supertab-connect/tinybird && uv run tinybird local start` |
| 8000 | Backend | run your supertab-connect backend (for analytics it needs `TINYBIRD_HOST`/`TINYBIRD_TOKEN` set — see below) |
| 8789 | Publisher origin | `npx tsx demos/cloudflare/origin.ts` |
| 8788 | Worker | `cd demos/cloudflare && npx wrangler dev --port 8788 --ip 127.0.0.1` |

Restart the Worker (port 8788) after step 1 so it bundles the fresh SDK build.

Sanity check the Worker sees its config: `curl http://127.0.0.1:8788/__debug`
(only exposed when `ALLOW_TEST_OVERRIDES=true`).

### 3. Run the tests

```bash
# (a) Worker behavior — validates the mode declared on the TEST_ENV entry
#     (default TEST_ENV=local-cloudflare → enforcement: observe → soft-no-bot-detection).
npx vitest run tests/e2e/enforcement.test.ts

# (b) Analytics pipeline — walks every emit branch, asserts rows in Tinybird.
#     Worker URL + Tinybird host + merchant URN come from the local-cloudflare
#     config entry; only the Tinybird token is passed here.
TB_ADMIN_TOKEN=$(cd ../supertab-connect/tinybird && uv run tinybird --local token ls | awk '/workspace admin token/{getline; print $2}') \
  npx tsx tests/e2e/cloudflare-e2e.ts
```

Expected: `(a)` → **3 passed | 12 skipped**; `(b)` → **PASS — analytics pipeline green (5 scenarios)**.

---

## How each test treats enforcement mode

These behave differently — this is the part that trips people up.

### `enforcement.test.ts` validates ONE mode — the deployment's, derived from config

It sends only `User-Agent` + `Authorization` — it does **not** switch the
Worker's mode (a deployed worker has one fixed mode and no test backdoor). The
mode under test is a **property of the deployment**, so it's declared on the env
entry in `config.ts` and the test derives `TEST_MODE` from it:

```ts
"contribute-strict": {
  resourceUrl: "https://www.contribute.app",
  baseUrl: "https://api-connect.supertab.co",
  enforcement: "enforce",   // → strict
  botDetection: true,
},
```

| `enforcement` + `botDetection` | derived `TEST_MODE` |
|--------------------------------|----------------------|
| `observe` + false (default)    | `soft-no-bot-detection` |
| `observe` + true               | `soft-bot-detection` |
| `enforce` + false              | `strict-no-bot-detection` |
| `enforce` + true               | `strict-bot-detection` |
| `disabled`                     | `disabled` |

So you pick **one** thing — `TEST_ENV` — and the matching mode follows; they
can't silently mismatch. To validate a strict deployment: add an entry with
`enforcement: "enforce"`, run `TEST_ENV=<name> npm test`, and it asserts strict
behavior (bot/no-token → 401, valid token → 200) against the live worker.

> The entry asserts the mode you *say* the site runs. If the deployment and the
> entry disagree, the test fails — which is a real signal, not a false alarm.
> (`TEST_MODE=<mode>` still overrides the derived value for local experiments.)

### `cloudflare-e2e.ts` exercises ALL branches in one run

It sends `X-Test-Enforcement` / `X-Test-Bot-Detection` headers per request, which
the demo Worker honors because `ALLOW_TEST_OVERRIDES=true`. So it walks
human/bot × observe/enforce/disabled × token states against a single
`wrangler dev`, without reconfiguring the Worker, and asserts each lands the
expected row (`source_cdn` / `client_ip` / `has_token` / `token_outcome` /
`final_action` / `enforcement_mode`).

---

## Analytics prerequisites (`cloudflare-e2e.ts`)

The Worker POSTs analytics to `${SUPERTAB_BASE_URL}/ingest/events`; the backend
stamps the merchant URN and forwards the row to Tinybird. For rows to land:

- `ANALYTICS_ENABLED=true` in `.dev.vars`.
- Backend reachable at `SUPERTAB_BASE_URL` with `TINYBIRD_HOST` + `TINYBIRD_TOKEN`
  set, **and the token must match the running local Tinybird workspace** — a
  stale/wrong token makes the backend accept the event (still HTTP 200) but the
  Tinybird write fails with `403`, so no row appears. Confirm with:
  ```bash
  cd ../supertab-connect/tinybird && uv run tinybird --local token ls   # compare to backend/.env TINYBIRD_TOKEN
  ```
- Tinybird Local up with `bot_events_raw` deployed
  (`uv run tinybird --local datasource ls`).

`MERCHANT_SYSTEM_URN` passed to the script must be the URN the backend derives
from the demo's `MERCHANT_API_KEY` (the `/__debug` endpoint prints it).

---

## Production analytics smoke (`analytics-smoke.ts`)

Verifies a **deployed** Worker's analytics actually persist to Tinybird — the
gap `enforcement.test.ts` leaves (it checks HTTP only) and that `cloudflare-e2e.ts`
can't cover in prod (it needs `ALLOW_TEST_OVERRIDES`). It's prod-safe: sends NO
`X-Test-*` headers (so the target needs no test backdoor), only exercises the
OBSERVE-reachable outcomes (no-token→allow/absent, malformed-token→block/malformed),
and tags every request with a unique path prefix so its rows are identifiable and
never confused with real traffic.

```bash
# Production — worker URL, Tinybird host, and merchant URN come from the
# production-cloudflare config entry; only the Tinybird token is passed.
cd ../supertab-connect/tinybird && set -a; . ./.env.prod; set +a   # TB_TOKEN
cd -    # back to SDK repo root
TEST_ENV=production-cloudflare TB_ADMIN_TOKEN="$TB_TOKEN" \
  npx tsx tests/e2e/analytics-smoke.ts
```

`ANALYTICS_EXPECTED=true` (default) asserts the rows land; set it to `false` to
assert that a worker deployed with analytics **off** produces no rows. With no
`TEST_ENV` it defaults to `local-cloudflare`, so the same script doubles as a
local check.

## Other environments

`enforcement.test.ts` can point at any env in `config.ts` via `TEST_ENV`
(`sandbox-*`, `production-cloudflare`, etc.) — just declare each entry's
`enforcement`/`botDetection` to match how that deployment is configured, and the
mode follows automatically. The Fastly demo (`demos/fastly`) runs the same test
against a Fastly Compute deployment.
