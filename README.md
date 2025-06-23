# Supertab Connect SDK

## Installation

```
npm install @laterpay/supertab-connect-sdk
# or
yarn add @laterpay/supertab-connect-sdk
```

## Basic Usage

### Manual setup
```js
import { SupertabConnect } from '@laterpay/supertab-connect-sdk';

// Initialize the SDK
const supertabConnect = new SupertabConnect({
  apiKey: 'stc_live_your_api_key',
  merchantSystemId: 'your_merchant_system_id',
});

// Verify a token
const verification = await supertabConnect.verifyToken(token);

// Record an event
await supertabConnect.recordEvent('page_viewed', token, {
  page_url: 'https://example.com/article',
  user_agent: 'Mozilla/5.0...'
});
```

### Fastly Compute Example
```js
/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { SupertabConnect } from "@laterpay/supertab-connect-sdk";

const configDict = new SecretStore("demo");

const supertabConnect = new SupertabConnect({
  apiKey: configDict.get("MERCHANT_API_KEY"),
  merchantSystemId: configDict.get("MERCHANT_SYSTEM_ID"),
});

// The entry point for the request handler.
addEventListener("fetch", (event) => event.respondWith(supertabConnect.handleRequest(event.request)));
```

## Configuration Options

The SDK is configured using the `SupertabConnectConfig` object

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `apiKey` | string | Yes | - | Your Supertab merchant API key
| `merchantSystemId` | string | Yes | - | Your merchant system identifier

## Public API Reference

### `fastlyHandleRequest(request: Request, ctx: any = null): Promise<Response>`

Handles the Supertab Connect part for each incoming HTTP request within Fastly CDN: it verifies the JWT token and records the event.

For examples see the [Fastly Compute Example](#fastly-compute-example) section above.

**Parameters:**
- `request` (Request): The incoming HTTP request object
- `ctx` (any, optional): Context object for the awaitable Promise from recordEvent call (e.g. Fastly context)

**Returns:**
- `Promise<Response>`: Result of bot detection, verification and event recording
  - If the requester is not a bot to be blocked, or if the token is present and valid, returns 200 OK
  - If token is invalid or missing, returns 403 Forbidden with either INVALID_TOKEN or MISSING_TOKEN as a reason

### `cloudflareHandleRequest(request: Request, ctx: any = null): Promise<Response>`

Handles the Supertab Connect part for each incoming HTTP request within CloudFlare CDN: it verifies the JWT token and records the event.

Parameters and return values are the same as `fastlyHandleRequest`.

### `verifyToken(token: string): Promise<TokenVerificationResult>`

Verifies self-signed JWT Tokens sent by the Customer and signed by their private-key. Internally, it fetches the JWKs hosted by Supertab Connect for the customer and verifies using the public key available.

**Parameters:**
- `token` (string): The JWT token to verify

**Returns:**
- `Promise<TokenVerificationResult>`: Object with verification result
  - `valid`: boolean indicating if token is valid
  - `reason`: string reason for failure (if invalid)
  - `payload`: decoded token payload (if valid)

Example

```js
const token = 'eyJhbGciOiJSUzI1...'; // Token from Authorization header
const verification = await supertabConnect.verifyToken(token);

if (verification.valid) {
  // Allow access to content
  console.log('Token verified successfully', verification.payload);
} else {
  // Block access
  console.log('Token verification failed:', verification.reason);
}
```

### `recordEvent(eventName: string, customerToken?: string, properties?: Record<string, any>): Promise<void>`

Records an event in the Supertab Connect platform.

**Parameters:**
- `eventName` (string): Name of the event to record
- `customerToken` (string, optional): The self-signed JWT token sent by the customer
- `properties` (object, optional): Additional properties to include with the event

Example:

```js
// Record a page view with additional properties
await supertabConnect.recordEvent('page_viewed', token, {
  page_url: request.url,
  user_agent: request.headers.get('User-Agent'),
  referrer: request.headers.get('Referer'),
  article_id: '12345'
});
