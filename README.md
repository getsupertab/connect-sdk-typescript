# Supertab Connect SDK

Check our [documentation](https://supertab-connect.mintlify.app/introduction/about-supertab-connect) for more information on Supertab Connect.

## Installation

```
npm install @getsupertab/supertab-connect-sdk
# or
yarn add @getsupertab/supertab-connect-sdk
```

## Basic Usage

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

const configDict = new SecretStore("demo");
const merchantApiKey = configDict.get("MERCHANT_API_KEY");

addEventListener("fetch", (event) =>
  event.respondWith(
    SupertabConnect.fastlyHandleRequests(
      event.request,
      merchantApiKey,
      "origin-backend"
    )
  )
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

### Manual Setup

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

| Parameter           | Type               | Required | Default  | Description                                                        |
| ------------------- | ------------------ | -------- | -------- | ------------------------------------------------------------------ |
| `apiKey`            | `string`           | Yes      | -        | Your Supertab merchant API key                                     |
| `enforcement`       | `EnforcementMode`  | No       | `SOFT`   | Enforcement mode: `DISABLED`, `SOFT`, or `STRICT`                  |
| `botDetector`       | `BotDetector`      | No       | -        | Custom bot detection function `(request, ctx?) => boolean`         |
| `debug`             | `boolean`          | No       | `false`  | Enable debug logging                                               |

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
| `debug`       | `boolean`          | No       | Enable debug logging                                             |
| `ctx`         | `ExecutionContext`  | No       | Execution context for non-blocking event recording               |

**Returns:** `{ valid: boolean; error?: string }`

### `handleRequest(request, ctx?): Promise<HandlerResult>`

Handles an incoming request end-to-end: extracts the license token from the `Authorization` header, verifies it, records an analytics event, and applies bot detection and enforcement mode when no token is present.

**Parameters:**

- `request` (`Request`): The incoming HTTP request
- `ctx` (`ExecutionContext`, optional): Execution context for non-blocking event recording

**Returns:** `HandlerResult` — either `{ action: "allow" }` or `{ action: "block", status, body, headers }`.

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
- `options.merchantSystemUrn` (`string`, optional): Required when `enableRSL` is `true`; the merchant system URN used to fetch `license.xml`
- `options.botDetector` (`BotDetector`, optional): Custom bot detection function
- `options.enforcement` (`EnforcementMode`, optional): Enforcement mode

### `cloudfrontHandleRequests(event, options): Promise<CloudFrontRequestResult>` (static)

Convenience handler for AWS CloudFront Lambda@Edge viewer-request functions.

**Parameters:**

- `event` (`CloudFrontRequestEvent`): The CloudFront viewer-request event
- `options` (`CloudfrontHandlerOptions`): Configuration object with `apiKey` and optional `botDetector`/`enforcement`

### `obtainLicenseToken(options): Promise<string>` (static)

Request a license token from the Supertab Connect token endpoint using OAuth2 client credentials.

**Parameters (options object):**

| Parameter      | Type      | Required | Description                                     |
| -------------- | --------- | -------- | ----------------------------------------------- |
| `clientId`     | `string`  | Yes      | OAuth client identifier                         |
| `clientSecret` | `string`  | Yes      | OAuth client secret for client_credentials flow |
| `resourceUrl`  | `string`  | Yes      | Resource URL to obtain a license for            |
| `debug`        | `boolean` | No       | Enable debug logging                            |

```
