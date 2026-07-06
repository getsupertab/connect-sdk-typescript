# Follow-up: `fastlyHandleRequests` should take the `FetchEvent`, not loose client fields

**Status:** done (clean break, no version bump yet — pending local review). JA3 now sourced from
`event.client.tlsJA3MD5` with the VCL header as fallback; `clientIp`/`requestCountry`/`requestAsn`
dropped from `FastlyHandlerOptions`.

## Problem

`fastlyHandleRequests(request, apiKey, originBackend, options)` takes `event.request`, but
then asks the caller to manually destructure three more fields off the *same* `FetchEvent`
and pass them back through `options`:

```js
SupertabConnect.fastlyHandleRequests(event.request, apiKey, "origin", {
  clientIp:       event.client.address,
  requestCountry: event.client.geo.country_code,
  requestAsn:     event.client.geo.as_number,
  // ...
})
```

On Fastly Compute these signals live on the `FetchEvent`, not on request headers — the
current header fallbacks (`fastly-client-ip`, `fastly-client-country-code`,
`fastly-client-asn`) only exist on VCL services. See `src/cdn.ts:143-144` and
`src/types.ts:161-168`.

## Why passing the event is better

1. Same source — `event.request` and `event.client.*` are one object; we already take half.
2. **Closes a real gap:** JA3 is read from `request.headers.get("fastly-client-ja3")`
   (`src/cdn.ts:172`), a VCL-only header. On Compute it's `event.client.tlsJA3MD5`, which we
   can't reach today. Accepting the event makes JA3 actually work on Compute.
   (JA4 has no `event.client` field in the Compute runtime — `@fastly/js-compute` exposes
   `tlsJA3MD5` but not JA4 — so JA4 stays header-only, VCL only.)
3. `fastlyHandleRequests` is already Fastly-specific (named that, takes a `backend`) — no
   portability reason to keep it on a generic `Request`. That constraint only matters for the
   core `handleRequest` / `handleFastlyRequest`.
4. Fewer ways to hold it wrong — today most callers (incl. our own demo, which passes none of
   these) silently get empty geo/IP.

## Recommendation

Change the first param to the event and read everything internally:

```js
SupertabConnect.fastlyHandleRequests(event, apiKey, "origin", { enableRSL, ... })
```

Internally read `event.request` + `event.client.{address, geo.country_code, geo.as_number,
tlsJA3MD5}`. Drop `clientIp` / `requestCountry` / `requestAsn` from `FastlyHandlerOptions`.

### Costs
- Breaking signature change.
- `FetchEvent` type comes from the `@fastly/js-compute` runtime (not a dep) — needs a small
  ambient declaration, like the existing `src/fastly.d.ts`.

### Softer alternative (if we want to avoid a hard break)
Accept **either** a `Request` or a `FetchEvent` as the first arg (duck-type on `.client` /
`.request`), auto-extract when it's an event, and deprecate the three manual fields. Given the
demo doesn't use them yet, a clean break is probably fine.

## Touch points when implementing
- `src/index.ts` — `fastlyHandleRequests` signature + wiring (~line 460)
- `src/cdn.ts` — `handleFastlyRequest` client-signal extraction (~line 135); wire JA3/JA4 from event
- `src/types.ts` — `FastlyHandlerBaseOptions` (drop clientIp/requestCountry/requestAsn, ~line 144)
- `src/fastly.d.ts` — add ambient `FetchEvent` / `ClientInfo` types
- `demos/fastly/src/index.js` — pass `event` instead of `event.request`
- tests
