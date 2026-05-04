# Cloudflare Worker Demo — Phase 2 Local Validation

Phase 2 of the bot-traffic analytics MVP. Runs the SDK v2.0 inside `wrangler dev`
and emits analytics events to a **local Tinybird** workspace. Local-only, not
for deployment.

What this demo exercises:

- The Workers fetch handler path
- `cf-connecting-ip` extraction from the request
- `ctx.waitUntil` fire-and-forget POST to the Tinybird Events API
- The `source_cdn = 'cloudflare'` row tag

## Prerequisites

1. **Tinybird Local running**

   ```sh
   cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird
   tb dev
   # Confirm health:
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7181/v0/health   # → 200
   ```

2. **SDK built** (this demo links to `../..` via `file:` reference)

   ```sh
   cd /Users/hassaanelgarem/supertab/connect-sdk-typescript
   npm run build
   ```

3. **Demo deps installed** (re-run any time the SDK is rebuilt)

   ```sh
   cd demos/cloudflare
   npm install
   ```

4. **`.dev.vars` configured.** A version is already committed to
   `demos/cloudflare/.dev.vars` with the workspace admin token from
   `tb --local token ls`. If the local token rotates, refresh it:

   ```
   MERCHANT_API_KEY=<merchant key registered in local supertab-connect>
   MERCHANT_SYSTEM_URN=urn:stc:merchant:system:<uuid>
   SUPERTAB_ANALYTICS_TOKEN=<paste from `tb --local token ls`>
   SUPERTAB_ANALYTICS_ENDPOINT=http://localhost:7181/v0/events?name=bot_events_raw
   SUPERTAB_BASE_URL=http://localhost:8000
   ```

   `SUPERTAB_BASE_URL` redirects the SDK's billing event-record path
   (`POST {baseUrl}/events`) and JWKS fetches at the local supertab-connect
   backend. The Worker calls `SupertabConnect.setBaseUrl(env.SUPERTAB_BASE_URL)`
   on each request when set. Omit the var to fall back to the prod default
   (`https://api-connect.supertab.co`).

5. **Local supertab-connect backend running** (only if you set
   `SUPERTAB_BASE_URL`). The backend listens on `:8000` — see
   `supertab-connect/docker-compose.yml` (`docker compose up backend`) or
   run it directly via uvicorn.

## What this demo Worker does

The Worker collapses the two production Workers from
`backend/src/services/cdn/orchestrators/cloudflare/instructions/` into one:

- `GET /license.xml` → proxies to
  `{SUPERTAB_BASE_URL}/merchants/systems/{MERCHANT_SYSTEM_URN}/license.xml`
  on the local backend. Mirrors the **RSL Worker** (`rsl_license.md`).
- everything else → `SupertabConnect.cloudflareHandleRequests`. Mirrors the
  **CAP Worker** (`cap_on_edge.md`).

In production these are two separate Workers behind two Worker Routes
(`*/license.xml` vs `*/*`); locally we put both in one fetch handler so a
single `wrangler dev` covers it.

## Ports

The Worker URL is the **publisher URL** — it's what clients (browsers,
tests) hit, and what license tokens are bound to via `aud`. The origin
sits behind the Worker on a different port (loopback prevents Worker and
origin sharing one). The SDK's new `originUrl` option keeps validation
URL (request URL) decoupled from pass-through fetch destination.

| Service                | Port | Notes                                              |
|------------------------|------|----------------------------------------------------|
| supertab-connect API   | 8000 | License/JWKS/event-record. Set `SUPERTAB_BASE_URL`. |
| Worker (publisher URL) | 8788 | What tests hit. Token `aud` must match this URL.   |
| Origin (publisher web) | 8789 | Hidden behind the Worker. Set via `ORIGIN_URL`.    |
| Tinybird Local         | 7181 | Optional, only if `SUPERTAB_ANALYTICS_TOKEN` set.   |

In production these problems vanish: Cloudflare Worker Routes put the
Worker on the publisher's hostname, so request URL == origin URL and
`fetch(request)` resolves to the publisher's origin via the edge.

## Run

`demos/cloudflare/origin.ts` is the single publisher-origin script (default
port 8789). Use it standalone for manual / browser testing; the Phase 2
harness imports its `startOrigin()` and owns the lifecycle in-process.

You need three terminals for the manual flow (or use the harness — see
"Automated end-to-end check" below).

```sh
# Terminal 1: local supertab-connect backend (and Tinybird if you want analytics)
cd /Users/hassaanelgarem/supertab/supertab-connect && docker compose up backend
# (optional, for analytics) cd tinybird && tb dev

# Terminal 2: publisher origin (HTML)
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript
npx tsx demos/cloudflare/origin.ts

# Terminal 3: Worker (publisher URL)
cd demos/cloudflare
npx wrangler dev --port 8788 --ip 127.0.0.1
```

Open `http://127.0.0.1:8788/` in a browser — you'll see the publisher
homepage served via the SDK's pass-through path. `http://127.0.0.1:8788/license.xml`
returns the RSL XML from the local backend.

## Automated end-to-end check

For a self-asserting run of all three scenarios at once (curl → worker →
Tinybird → assert each row), use the harness in `tests/e2e/cloudflare-e2e.ts`.
With `wrangler dev` running in this directory and `tb dev` running in
`supertab-connect/tinybird/`:

```sh
cd /Users/hassaanelgarem/supertab/connect-sdk-typescript
TB_ADMIN_TOKEN=$(tb --local token ls | awk '/workspace admin token/ {getline; print $2}') \
  npx tsx tests/e2e/cloudflare-e2e.ts
```

Exits non-zero on any failure. Each run uses a per-run path prefix
(`/phase2-e2e-<runId>/...`) so reruns don't collide.

## Test scenarios (manual)

Each scenario sets `CF-Connecting-IP` explicitly so the row's `client_ip`
matches the curl. (Wrangler local injects `cf-connecting-ip=127.0.0.1` by
default if the header is omitted; explicit values override.)

### 1. Human UA → allow / human

```sh
curl -i \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
  -H 'Accept-Language: en-US,en;q=0.9' \
  -H 'Referer: https://search.example.com/' \
  -H 'CF-Connecting-IP: 198.51.100.1' \
  http://127.0.0.1:8788/phase2/human
```

Expect: HTTP 200, `phase2 demo OK …` body.

### 2. GPTBot → observe / unverified_bot

```sh
curl -i \
  -H 'User-Agent: GPTBot/1.0' \
  -H 'CF-Connecting-IP: 198.51.100.2' \
  http://127.0.0.1:8788/phase2/gptbot
```

Expect: HTTP 200 with RSL signal headers (`Link`, `X-RSL-Reason: missing`,
`X-RSL-Status: token_required`).

### 3. GPTBot + License header → block / malformed token

```sh
curl -i \
  -H 'User-Agent: GPTBot/1.0' \
  -H 'CF-Connecting-IP: 198.51.100.3' \
  -H 'Authorization: License not-a-real-jwt' \
  http://127.0.0.1:8788/phase2/token
```

Expect: HTTP 401 with `WWW-Authenticate: License error="invalid_token", …`.

### 4. License XML → proxied from local backend

```sh
curl -i http://127.0.0.1:8788/license.xml
```

Expect: HTTP 200, `Content-Type: application/xml`, RSL XML body.
Internally the Worker fetches
`http://localhost:8000/merchants/systems/{MERCHANT_SYSTEM_URN}/license.xml`
and returns it. CAP/SDK is intentionally not invoked on this path — that
matches the prod two-Worker split where `/license.xml` has its own route.

The SDK skips the bot detector on the token-present path (by design — see
`scratch/HANDOFF.md` §4.5), so `bot_detector_result=unknown` even though the
UA is `GPTBot`.

## Verify in Tinybird

Run from `supertab-connect/tinybird/` (the `tb` CLI resolves resources from cwd):

```sh
cd /Users/hassaanelgarem/supertab/supertab-connect/tinybird

tb --local sql "SELECT request_id, source_cdn, client_ip, has_token, token_outcome, bot_detector_result, final_action, enforcement_mode FROM bot_events_raw WHERE merchant_system_urn = '<your urn>' ORDER BY timestamp DESC LIMIT 5"
```

Expected rows after running scenarios 1–3:

| client_ip               | has_token | token_outcome | bot_detector_result | final_action |
|-------------------------|-----------|---------------|---------------------|--------------|
| `::ffff:198.51.100.3`   | True      | malformed     | unknown             | block        |
| `::ffff:198.51.100.2`   | False     | absent        | unverified_bot      | observe      |
| `::ffff:198.51.100.1`   | False     | absent        | human               | allow        |

Confirm `source_cdn = 'cloudflare'` on every row.

Quarantine sanity check (errors with "Datasource not found" — that's the
healthy state; Tinybird only materializes `_quarantine` if a row fails
ingest validation):

```sh
tb --local sql "SELECT count() FROM bot_events_raw_quarantine"
```

## Known non-fatal log lines

You will see these in `wrangler dev` output. They do not affect Phase 2:

- `Invalid license JWT header: TypeError: …` — emitted by the SDK on
  Scenario 3 because the token literally is not a JWT. The 401 response
  and the analytics row both land correctly.
- `Failed to record event: <status>` — the **billing** path posts to
  `{SUPERTAB_BASE_URL}/events`. If the local backend isn't running, or the
  `MERCHANT_API_KEY` isn't registered there, this fails. Independent of
  analytics; analytics fire-and-forget POST to Tinybird succeeds via
  `ctx.waitUntil` regardless.

## What changed from the pre-Phase-2 demo

- SDK dep switched from npm (`^0.1.0-beta.19`) to `file:../..` (local build)
- `.dev.vars` gained `MERCHANT_SYSTEM_URN`, `SUPERTAB_ANALYTICS_TOKEN`,
  `SUPERTAB_ANALYTICS_ENDPOINT`, `SUPERTAB_BASE_URL`, `ORIGIN_URL`
- `src/index.ts`:
  - Calls `SupertabConnect.setBaseUrl(env.SUPERTAB_BASE_URL)` per request
    when set, so the SDK's billing/event-record path and JWKS fetches hit
    the local supertab-connect backend instead of prod.
  - On `GET /license.xml`, proxies straight to
    `{SUPERTAB_BASE_URL}/merchants/systems/{MERCHANT_SYSTEM_URN}/license.xml`
    (mirrors the RSL Worker; CAP is not invoked on this path).
  - Otherwise calls `SupertabConnect.cloudflareHandleRequests` with the
    request unchanged plus `originUrl: env.ORIGIN_URL`. The SDK validates
    the license against `request.url` (so token `aud` matches the Worker
    URL — the publisher URL), and on ALLOW/OBSERVE pass-through fetches
    from `originUrl` instead. Locally that points at the `:8789` origin;
    production Cloudflare deployments using Workers Routes can omit the
    option since `fetch(request)` already resolves to the origin.
  - Analytics is now opt-in: `analyticsEnabled: !!env.SUPERTAB_ANALYTICS_TOKEN`.
    Comment out / remove the token from `.dev.vars` to skip Tinybird.
- `demos/cloudflare/origin.ts` — single publisher-origin script. Serves
  HTML for `/` and `/articles/*`, plain text otherwise (covers harness
  paths). Standalone runner for manual / browser testing; exports
  `startOrigin()` for `tests/e2e/cloudflare-e2e.ts` to drive in-process.
  (Replaced an earlier duplicate `scratch/cloudflare-origin.ts`.)
