# Supertab Connect SDK

Check our [documentation](https://supertab-connect.mintlify.app/introduction/about-supertab-connect) for more information on Supertab Connect.

## Installation

```
npm install @getsupertab/supertab-connect-sdk
# or
yarn add @getsupertab/supertab-connect-sdk
```

## Basic Usage

### Manual setup

```js
import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";

// Initialize the SDK
const supertabConnect = new SupertabConnect({
  apiKey: "stc_live_your_api_key",
  merchantSystemUrn: "your_merchant_system_urn",
});

// Verify a license token
const verification = await supertabConnect.verifyLicenseToken(
  licenseToken,
  "https://example.com/article"
);

// Record an event
await supertabConnect.recordEvent("page_viewed", {
  page_url: "https://example.com/article",
  user_agent: "Mozilla/5.0...",
});
```

### Fastly Compute Example

```js
/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";

const configDict = new SecretStore("demo");
const config = {
  apiKey: configDict.get("MERCHANT_API_KEY"),
  merchantSystemUrn: configDict.get("MERCHANT_SYSTEM_URN"),
};

// The entry point for the request handler.
addEventListener("fetch", (event) =>
  event.respondWith(
    SupertabConnect.fastlyHandleRequests(
      event.request,
      config.merchantSystemUrn,
      config.apiKey
    )
  )
);
```

### CloudFlare Worker Example

```ts
import { SupertabConnect, Env } from "@getsupertab/supertab-connect-sdk";

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

## Configuration Options

The SDK is configured using the `SupertabConnectConfig` object

| Parameter           | Type   | Required | Default | Description                     |
| ------------------- | ------ | -------- | ------- | ------------------------------- |
| `apiKey`            | string | Yes      | -       | Your Supertab merchant API key  |
| `merchantSystemUrn` | string | Yes      | -       | Your merchant system identifier |

## Public API Reference

### `constructor(config: SupertabConnectConfig, reset: boolean = false)`

Creates a new instance of the SupertabConnect SDK.
If the SDK was already initialized and the config parameters are different, it will throw an error unless `reset` is set to true.

```ts
import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";

const supertabConnect = new SupertabConnect({
  apiKey: "stc_live_your_api_key",
  merchantSystemUrn: "your_merchant_system_urn",
});
```

### `resetInstance(): void`

Resets the singleton instance of SupertabConnect allowing to create an instance with a new config.
We expect this to not be called in the usual production setup as the SDK is designed to intercept requests using specific public methods.

### `fastlyHandleRequests(request: Request, merchantSystemUrn: string, merchantApiKey: string, enableRSL?: boolean): Promise<Response>`

Handles the Supertab Connect part for each incoming HTTP request within Fastly CDN: it verifies the license token and records the event.

For examples see the [Fastly Compute Example](#fastly-compute-example) section above.

**Parameters:**

- `request` (Request): The incoming HTTP request object
- `merchantSystemUrn` (string): Your merchant system identifier (recommended to be stored in a Fastly SecretStore)
- `merchantApiKey` (string): Your Supertab merchant API key (recommended to be stored in a Fastly SecretStore)
- `enableRSL` (boolean, optional): Enable RSL license.xml hosting (default: false)

**Returns:**

- `Promise<Response>`: Result of bot detection, verification and event recording
  - If the requester is not a bot to be blocked, or if the license token is present and valid, returns 200 OK
  - If license token is invalid or missing, returns 401 Unauthorized

### `cloudflareHandleRequests(request: Request, env: Env, ctx: any = null): Promise<Response>`

Handles the Supertab Connect part for each incoming HTTP request within CloudFlare CDN: it verifies the license token and records the event.

For examples see the [CloudFlare Worker Example](#cloudflare-worker-example) section above.

**Parameters:**

- `request` (Request): The incoming HTTP request object
- `env` (Env): Environment variables provided for CloudFlare Workers (MERCHANT_API_KEY and MERCHANT_SYSTEM_URN must be present)
- `ctx` (ExecutionContext): Execution context passed from `fetch` worker method for awaiting async operations

**Returns:**

- `Promise<Response>`: Result of bot detection, verification and event recording
  - If the requester is not a bot to be blocked, or if the license token is present and valid, returns 200 OK
  - If license token is invalid or missing, returns 401 Unauthorized

### `handleRequest(request: Request, botDetectionHandler?: (request: Request, ctx?: any) => boolean,  ctx?: any): Promise<Response>`

A method for handling requests in a generic way, allowing custom bot detection logic.
Any of out-of-the-box bot detector methods can be used or a custom one can be supplied provided it follows the specified signature.

**Parameters:**

- `request` (Request): The incoming HTTP request object
- `botDetectionHandler` (function, optional): Custom function to detect bots. It should return a boolean indicating if the request is from a bot.
- `ctx` (ExecutionContext, optional): Context object to for awaiting async operations

**Returns:**

- `Promise<Response>`: Result of bot detection, verification and event recording
  - If the requester is not a bot to be blocked, or if the license token is present and valid, returns 200 OK
  - If license token is invalid or missing, returns 401 Unauthorized

### `verifyLicenseToken(licenseToken: string, requestUrl: string): Promise<LicenseTokenVerificationResult>`

Verifies license tokens issued by the Supertab platform. Internally, it fetches the platform JWKs hosted by Supertab Connect and verifies the ES256 signature.

**Parameters:**

- `licenseToken` (string): The license token to verify
- `requestUrl` (string): The URL of the request being made (used for audience validation)

**Returns:**

- `Promise<LicenseTokenVerificationResult>`: Object with verification result
  - `valid`: boolean indicating if token is valid
  - `reason`: string reason for failure (if invalid)
  - `licenseId`: the license ID (if valid)
  - `payload`: decoded token payload (if valid)

Example

```js
const licenseToken = "eyJhbGciOiJFUzI1..."; // Token from Authorization header
const verification = await supertabConnect.verifyLicenseToken(
  licenseToken,
  "https://example.com/article"
);

if (verification.valid) {
  // Allow access to content
  console.log("License verified successfully", verification.licenseId);
} else {
  // Block access
  console.log("License verification failed:", verification.reason);
}
```

### `recordEvent(eventName: string, properties?: Record<string, any>, licenseId?: string): Promise<void>`

Records an event in the Supertab Connect platform.

**Parameters:**

- `eventName` (string): Name of the event to record
- `properties` (object, optional): Additional properties to include with the event
- `licenseId` (string, optional): License ID associated with the event

Example:

```js
// Record a page view with additional properties
await supertabConnect.recordEvent("page_viewed", {
  page_url: request.url,
  user_agent: request.headers.get("User-Agent"),
  referrer: request.headers.get("Referer"),
  article_id: "12345",
});
```

### `checkIfBotRequest(request: Request): boolean`

A simple check based on the information passed in request's Headers to decide whether it comes from a crawler/bot/AI agent or not.

**Parameters:**

- `request` (Request): The incoming HTTP request object

**Returns:**

- `boolean`: True if the request's Headers fall into the conditions to identify requester as a bot; False otherwise.

### `generateLicenseToken(clientId: string, kid: string, privateKeyPem: string, resourceUrl: string, licenseXml: string): Promise<string>`

Requests a license token from the Supertab Connect token endpoint using OAuth2 client assertion.

**Parameters:**

- `clientId` (string): OAuth client identifier used for the assertion issuer/subject claims, fetched from the System Detail page
- `kid` (string): Key ID to include in the JWT header
- `privateKeyPem` (string): Private key in PEM format used to sign the client assertion
- `resourceUrl` (string): Resource URL attempting to access with a License
- `licenseXml` (string): XML license document associated with the resource url attempting to access

**Returns:**

- `Promise<string>`: The issued license access token
