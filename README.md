# Supertab Connect SDK

Check our [documentation](https://connect-docs.supertab.co/introduction/about-supertab-connect) for more information on Supertab Connect.

[![npm](https://img.shields.io/npm/v/%40getsupertab%2Fsupertab-connect-sdk.svg)](https://www.npmjs.com/package/%40getsupertab%2Fsupertab-connect-sdk)
[![License](https://img.shields.io/npm/l/%40getsupertab%2Fsupertab-connect-sdk.svg)](https://github.com/getsupertab/connect-sdk-typescript/blob/main/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/getsupertab/connect-sdk-typescript/ci.yml?branch=main)](https://github.com/getsupertab/connect-sdk-typescript/actions/workflows/ci.yml)
[![TypeScript Types](https://img.shields.io/npm/types/%40getsupertab%2Fsupertab-connect-sdk.svg)](https://www.npmjs.com/package/%40getsupertab%2Fsupertab-connect-sdk)
[![Node.js Version](https://img.shields.io/node/v/%40getsupertab%2Fsupertab-connect-sdk.svg)](https://www.npmjs.com/package/%40getsupertab%2Fsupertab-connect-sdk)

## Installation

```
npm install @getsupertab/supertab-connect-sdk
# or
yarn add @getsupertab/supertab-connect-sdk
```

## Customer Usage

Obtain a license token for a resource URL:

```ts
import { SupertabConnect, UsageType } from "@getsupertab/supertab-connect-sdk";

const token = await SupertabConnect.obtainLicenseToken({
  clientId: "your_client_id",
  clientSecret: "your_client_secret",
  resourceUrl: "https://example.com/premium/article",
  usage: UsageType.SEARCH,
});

if (token) {
  // Send the token as: Authorization: License <token>
} else {
  // No token is required for this resource and usage.
}
```

## Merchant Usage

Supertab Connect SDK offers various CDN-attuned implementations of CAP ([Crawler Authentication Protocol](https://connect-docs.supertab.co/licensing/crawler-authentication-protocol)).

### Cloudflare Workers

```ts
import { SupertabConnect, Env, ExecutionContext } from "@getsupertab/supertab-connect-sdk";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return SupertabConnect.cloudflareHandleRequests(request, env, ctx);
  },
};
```

### Fastly Compute

```js
/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";

addEventListener("fetch", (event) =>
  event.respondWith((async () => {
    const configDict = new SecretStore("demo");
    const merchantApiKey = await configDict.get("MERCHANT_API_KEY");

    return SupertabConnect.fastlyHandleRequests(
      event.request,
      merchantApiKey,
      "origin-backend"
    );
  })())
);
```

### AWS CloudFront Lambda@Edge

```ts
import {
  SupertabConnect,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "@getsupertab/supertab-connect-sdk";

export async function handler(
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequestResult> {
  return SupertabConnect.cloudfrontHandleRequests(event, {
    apiKey: "stc_live_your_api_key",
  });
}
```

> **Analytics is not supported on CloudFront.** The Lambda@Edge handler performs
> verification and enforcement only — it does not emit analytics events. Relay
> analytics is available on Cloudflare and Fastly, which emit one event per
> request (Fastly is the primary edge target for analytics).

### Manual Setup

If you want to do a manual integration, the SDK also provides low-level methods for token verification and event recording.

```ts
import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";

const supertabConnect = new SupertabConnect({
  apiKey: "stc_live_your_api_key",
});

// Verify a license token and record an analytics event
const result = await supertabConnect.verifyAndRecord({
  token: licenseToken,
  resourceUrl: "https://example.com/article",
  userAgent: request.headers.get("User-Agent") ?? undefined,
  ctx, // pass your platform's execution context for non-blocking event recording
});

if (result.valid) {
  // Allow access
} else {
  console.log("Denied:", result.error);
}
```

## Configuration Options

The SDK is configured using the `SupertabConnectConfig` object:

| Parameter            | Type                 | Required | Default     | Description                                                                          |
| -------------------- | -------------------- | -------- | ----------- | ------------------------------------------------------------------------------------ |
| `apiKey`             | `string`             | Yes      | -           | Your Supertab merchant API key                                                       |
| `enforcement`        | `EnforcementMode`    | No       | `OBSERVE`   | Enforcement mode: `DISABLED`, `OBSERVE`, or `ENFORCE`                                 |
| `botDetector`        | `BotDetector`        | No       | -           | Custom bot detection function `(request, ctx?) => boolean`                           |
| `debug`              | `boolean`            | No       | `false`     | Enable debug logging                                                                 |
| `analyticsEnabled`   | `boolean`            | No       | `false`     | Emit one analytics event per request to the Supertab Connect relay (see [Analytics](#analytics)) |

## Analytics

The SDK can emit one analytics event per request to the Supertab Connect
**relay** endpoint at `{baseUrl}/ingest/events`. This is **off by default** — enable
it by passing `analyticsEnabled: true`:

```ts
const supertabConnect = new SupertabConnect({
  apiKey: "stc_live_your_api_key",
  analyticsEnabled: true,
});
```

The same flag is available on the Cloudflare and Fastly convenience handlers
(`cloudflareHandleRequests`, `fastlyHandleRequests`) via their `options` object.
Analytics is not supported on CloudFront.

**No extra credentials are required.** Analytics requests are authenticated with
your configured merchant `apiKey` using `Authorization: Bearer <apiKey>`. The
backend derives merchant identity from the API key, so the SDK sends **no
merchant identifier** in the analytics payload.

Each event captures the request id, source CDN, a normalized client IP, and the
verification/enforcement decision for the request. When the CDN exposes them, it
also captures richer fingerprinting signals for downstream bot- and
spoof-analysis in the warehouse:

- the request country, ASN, and TLS fingerprint;
- `Sec-Fetch-*` and client-hint (`Sec-CH-UA*`) request headers; the set of
  header names sent; and whether a cookie was present (the cookie **value** is
  never stored, only its presence);
- connection-level signals on Cloudflare (from `request.cf`): negotiated HTTP
  protocol, TLS version/cipher, TLS ClientHello length and extension
  fingerprint, and the CDN's verified-bot category;
- query-string shape signals — length, parameter count, and a
  suspicious-pattern flag (the raw query string itself is never stored);
- HTTP Message Signature headers, when present.

Analytics events emit `schema_version: 2`. Classification stays query-time in
the warehouse — the SDK emits raw signals only and does not label traffic.

**Fail-open:** analytics emission is fire-and-forget and can never block, slow,
or alter request handling. If emission fails, the error is swallowed and the
request proceeds exactly as it would with analytics disabled. Analytics is also
fully isolated from billing — it is sent only to the relay at `/ingest/events`.

> The relay endpoint is `POST /ingest/events` on the Supertab Connect backend.

Analytics is sent to `{baseUrl}/ingest/events`; point it at another environment
with `setBaseUrl()`.

### Fastly: native logging delivery (optional)

On Fastly, analytics can be delivered through a **native Fastly real-time
logging endpoint** (`fastly:logger` → S3 → Tinybird) instead of the HTTP relay,
which keeps the per-request event firehose off the Supertab Connect backend.
Enable it by passing `logEndpoint` (the name of a logging endpoint configured on
your Fastly service) together with `merchantSystemUrn` to `fastlyHandleRequests`:

```js
return SupertabConnect.fastlyHandleRequests(
  event.request,
  merchantApiKey,
  "origin-backend",
  {
    analyticsEnabled: true,
    logEndpoint: "bot_events",
    merchantSystemUrn: "urn:supertab:merchant-system:...",
  }
);
```

`merchantSystemUrn` is required for native logging — there's no backend to derive
merchant identity in this path, so the SDK stamps it onto each row. If
`logEndpoint` is omitted (or `merchantSystemUrn` is missing), Fastly analytics
falls back to the HTTP relay. This option is Fastly-only; Cloudflare always uses
the HTTP relay.

## Status endpoint

The SDK serves a self-report endpoint at `GET /.well-known/supertab/status` on
your origin. It lets the Supertab Connect backend confirm a deployed SDK's live
configuration — this powers the merchant portal's live-health view. It is served
automatically across all runtimes; no configuration is required.

The endpoint is gated: it returns config **only** to a request carrying a valid,
backend-minted signed challenge (`Authorization: Bearer <challenge>`). Any other
request — no challenge, or an invalid/expired one — gets a minimal
`{ "supertab": true }` 404. Both responses set `Cache-Control: no-store`.

On a valid challenge it returns the SDK's running config:

```json
{
  "runtime": "cloudflare",
  "sdkVersion": "2.1.0",
  "enforcement": "observe",
  "eventReporting": true
}
```

It short-circuits at the top of request handling — before token verification, bot
detection, and analytics — so a probe never triggers enforcement or emits an
analytics event. Ensure your edge config lets this path reach the SDK rather than
routing it elsewhere.

## Public API Reference

### `constructor(config: SupertabConnectConfig, reset?: boolean)`

Creates a new SupertabConnect instance (singleton). Returns the existing instance if one already exists with the same config. Throws if an instance with different config exists unless `reset` is `true`.

### `resetInstance(): void`

Clear the singleton instance, allowing a new one to be created with different config.

### `verify(options): Promise<RSLVerificationResult>` (static)

Pure token verification — verifies a license token without recording any events.

**Parameters (options object):**

| Parameter     | Type      | Required | Description                                      |
| ------------- | --------- | -------- | ------------------------------------------------ |
| `token`       | `string`  | Yes      | The license token to verify                      |
| `resourceUrl` | `string`  | Yes      | The URL of the resource being accessed            |
| `baseUrl`     | `string`  | No       | Override for the Supertab Connect API base URL    |
| `debug`       | `boolean` | No       | Enable debug logging                             |

**Returns:** `{ valid: boolean; error?: string }`

```ts
const result = await SupertabConnect.verify({
  token: licenseToken,
  resourceUrl: "https://example.com/article",
});
```

### `verifyAndRecord(options): Promise<RSLVerificationResult>`

Verifies a license token and records an analytics event. Uses the instance's `apiKey` for event recording.

**Parameters (options object):**

| Parameter     | Type               | Required | Description                                                      |
| ------------- | ------------------ | -------- | ---------------------------------------------------------------- |
| `token`       | `string`           | Yes      | The license token to verify                                      |
| `resourceUrl` | `string`           | Yes      | The URL of the resource being accessed                            |
| `userAgent`   | `string`           | No       | User agent string for event recording                            |
| `requestHeaders` | `Record<string, string>` | No | Request headers to include in event properties                    |
| `debug`       | `boolean`          | No       | Enable debug logging                                             |
| `ctx`         | `ExecutionContext`  | No       | Execution context for non-blocking event recording               |

**Returns:** `{ valid: boolean; error?: string }`

### `handleRequest(request, context?): Promise<HandlerResult>`

Handles an incoming request end-to-end: extracts the license token from the `Authorization` header, verifies it, optionally emits a relay analytics event, and applies bot detection and enforcement mode when no token is present.

**Parameters:**

- `request` (`Request`): The incoming HTTP request
- `context` (`HandleRequestContext`, optional): Per-request context object. Carries the execution context (`ctx`) for non-blocking work, the `sourceCdn`, and CDN-supplied analytics signals (`clientIp`, `requestId`, `requestCountry`, `requestAsn`, `tlsFingerprint`).

**Returns:** `HandlerResult` — one of `{ action: "allow", headers? }`, `{ action: "block", status, body, headers }`, or `{ action: "respond", status, body, headers }` (the SDK serving its own response, e.g. the [status endpoint](#status-endpoint)). In observe mode, a bot without a token is allowed through with RSL signal headers (`X-RSL-Status: token_required`); the analytics event still records `final_action: "observe"`.

### `cloudflareHandleRequests(request, env, ctx): Promise<Response>` (static)

Convenience handler for Cloudflare Workers. Reads config from Worker environment bindings (`MERCHANT_API_KEY`).

**Parameters:**

- `request` (`Request`): The incoming Worker request
- `env` (`Env`): Worker environment bindings
- `ctx` (`ExecutionContext`): Worker execution context

### `fastlyHandleRequests(request, merchantApiKey, originBackend, options?): Promise<Response>` (static)

Convenience handler for Fastly Compute.

**Parameters:**

- `request` (`Request`): The incoming Fastly request
- `merchantApiKey` (`string`): Your Supertab merchant API key
- `originBackend` (`string`): The Fastly backend name to forward allowed requests to
- `options.enableRSL` (`boolean`, optional): Serve `license.xml` at `/license.xml` for RSL-compliant clients (default: `false`)
- `options.merchantSystemUrn` (`string`): Required when `enableRSL` is `true` (to fetch `license.xml`) and when using native Fastly logging (`logEndpoint`, to stamp analytics rows with merchant identity). Enforced at the type level via a discriminated union (`FastlyHandlerOptions`).
- `options.logEndpoint` (`string`, optional): Name of a Fastly real-time logging endpoint. When set (with `merchantSystemUrn`), analytics events are delivered through native Fastly logging (→ S3 → Tinybird) instead of the HTTP relay. Omit it to use the relay.
- `options.botDetector` (`BotDetector`, optional): Custom bot detection function
- `options.enforcement` (`EnforcementMode`, optional): Enforcement mode (default `OBSERVE`)
- `options.analyticsEnabled` (`boolean`, optional): Emit analytics events (default `false`)

The `options` parameter is optional. RSL hosting (`enableRSL` + `merchantSystemUrn`) is independent of analytics. For analytics, `merchantSystemUrn` is sent only on the native-logging path (where the SDK stamps it onto each row); on the HTTP relay path the backend derives merchant identity from the API key and no merchant identifier is sent.

### `cloudfrontHandleRequests(event, options): Promise<CloudFrontRequestResult>` (static)

Convenience handler for AWS CloudFront Lambda@Edge viewer-request functions.

**Parameters:**

- `event` (`CloudFrontRequestEvent`): The CloudFront viewer-request event
- `options` (`CloudfrontHandlerOptions`): Configuration object with `apiKey` and optional `botDetector`/`enforcement`. CloudFront does not emit analytics events.

### `obtainLicenseToken(options): Promise<string | undefined>` (static)

Request a license token from the Supertab Connect token endpoint using OAuth2 client credentials.

If `usage` is provided and a matching `<content>` block permits that usage without requiring a license token,
the SDK returns `undefined` instead of requesting a token as this is the valid behavior.

**Parameters (options object):**

| Parameter      | Type        | Required | Description                                              |
| -------------- | ----------- | -------- | -------------------------------------------------------- |
| `clientId`     | `string`    | Yes      | OAuth client identifier                                  |
| `clientSecret` | `string`    | Yes      | OAuth client secret for client_credentials flow          |
| `resourceUrl`  | `string`    | Yes      | Resource URL to obtain a license for                     |
| `usage`        | `UsageType` | No       | Usage being requested; enables serverless usage matching |
| `debug`        | `boolean`   | No       | Enable debug logging                                     |

```ts
import { SupertabConnect, UsageType } from "@getsupertab/supertab-connect-sdk";

const token = await SupertabConnect.obtainLicenseToken({
  clientId: "your_client_id",
  clientSecret: "your_client_secret",
  resourceUrl: "https://example.com/articles/post-1",
  usage: UsageType.SEARCH,
});

if (token === undefined) {
  // The matching serverless license already permits this usage.
} else {
  // Use the token in the Authorization header.
}
```
