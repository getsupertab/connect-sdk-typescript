# Cloudflare Worker Demo

One Cloudflare Worker demo that runs in **two modes** from the same code
(`src/index.ts`) and the same `wrangler.jsonc`, selected by wrangler environment:

| Mode | Command | What it is |
|---|---|---|
| **Local** (default) | `npm run dev` (`wrangler dev`) | local development in front of `origin.ts` (:8789), backend on :8000 |
| **Production** | `npm run deploy:production` (`wrangler deploy --env production`) | the deployed worker on `contribute.app` via a Workers Route |

The worker validates each request with the SDK, **OBSERVE**s by default (records,
never blocks), and—when `ANALYTICS_ENABLED=true`—emits one relay analytics event
per request to `${SUPERTAB_BASE_URL}/ingest/events`, where the backend stamps the
merchant URN and forwards it to Tinybird. ALLOW traffic is proxied to `ORIGIN_URL`
(so it never loops back through the worker's own route).

> The SDK dependency is `file:../..` — the **local workspace build**. Deploying
> bundles your current SDK code. If you specifically need to test the *published*
> npm artifact, temporarily set `@getsupertab/supertab-connect-sdk` to the version
> string in `package.json` and `npm install`.

## Configuration

| Var | Local (`.dev.vars`) | Production (`wrangler.jsonc` → `env.production.vars`) |
|---|---|---|
| `SUPERTAB_BASE_URL` | `http://localhost:8000` | `https://api-connect.supertab.co` |
| `ORIGIN_URL` | `http://127.0.0.1:8789` | `https://example.com` |
| `ANALYTICS_ENABLED` | `true`/`false` | `true` |
| `ALLOW_TEST_OVERRIDES` | `true` (honors `X-Test-*` headers; enables `/__debug`) | unset |
| `MERCHANT_API_KEY` | `.dev.vars` | Wrangler **secret** on the deployed worker |

`MERCHANT_API_KEY` must belong to the same environment as `SUPERTAB_BASE_URL` (a
prod key with the prod backend), or the analytics relay rejects it with 401.

## Local development

1. Create `.dev.vars` (see `.dev.vars.example`) with at least `MERCHANT_API_KEY`,
   plus `SUPERTAB_BASE_URL`, `ORIGIN_URL`, `ANALYTICS_ENABLED`, `ALLOW_TEST_OVERRIDES`.
2. Start the local origin: `npx tsx origin.ts` (serves :8789).
3. `npm run dev` — worker on :8788. Hit it:
   ```sh
   curl http://127.0.0.1:8788/                       # no token → 200 (OBSERVE)
   curl -H "Authorization: License <jwt>" http://127.0.0.1:8788/   # token path
   curl http://127.0.0.1:8788/__debug                # shows the env the worker sees
   ```
   (See `tests/e2e/` for the JWT-minting flow and the `local-cloudflare` test env.)

## Production deploy

```sh
npm install
npx wrangler secret put MERCHANT_API_KEY --env production   # one-time
npm run deploy:production
```

`env.production` carries the `*contribute.app/*` route, the prod vars above, and
`name: supertab-sdk-worker` (the live worker), so deploys update it in place.

### Requirements / gotchas

- The route hostname (`www.contribute.app`) must be **Proxied (orange-cloud)** in
  Cloudflare, or the route never fires and the host serves the origin's own
  (mismatched) TLS cert.
- Analytics only persist if the backend relay's Tinybird token has append rights
  on `bot_events_raw` in the target workspace — a wrong/under-scoped token shows
  up as `403 Forbidden` on `/v0/events` in Sentry, event silently dropped (the
  merchant request still succeeds — fail-open).
- `/__debug` is gated behind `ALLOW_TEST_OVERRIDES`, so it is not exposed in
  production.
