# STC-697 follow-up — Fastly analytics delivery reliability

**Status:** option (B) implemented, pending beta verification. Once `fastlyHandleRequests`
took the `FetchEvent` (see `fastly-handler-pass-event-followup.md`), the API blocker for (B)
was gone. `fastlyHandleRequests` now bridges `FetchEvent.waitUntil` into the analytics
`ExecutionContext` and threads it through `handleFastlyRequest` → `handleRequest`, so both
detached paths (log import **and** relay fetch) are held until they settle. Both transports
already honored `ctx.waitUntil`, so no transport change was needed — and option (A) is moot.
The production spot-check below is still the real gate before calling this closed.

Relates to `roadmap.md` Phase 8 ("Resolve Fastly analytics delivery reliability").

The rest of this note is retained as the original analysis / rationale.

---

## TL;DR

On Fastly, analytics events are emitted from a **detached promise** with no
`waitUntil` keeping the instance alive. Whether that promise runs before the
instance is reclaimed after the response is **not guaranteed by the platform** —
it's relying on undefined host behavior. This affects **both** Fastly analytics
transports, and is structurally worst on the **BLOCK** path.

PR #33 ships the routing (native logging when `logEndpoint` is set, HTTP relay
otherwise) but does **not** close this gap. The "make it land on-path" fix was
drafted, validated, and intentionally **reverted** so the branch could merge clean.

---

## Root cause

`handleFastlyRequest` never establishes a keep-alive for post-response work:

- Cloudflare (`src/cdn.ts`, ~line 52) passes `ctx` (with `waitUntil`) into `handleRequest`.
- **Fastly (`src/cdn.ts`, ~line 119) passes no `ctx` at all.**

So on Fastly, any async work `emit()` starts after the response is a detached
promise. The platform's only "stay alive until this finishes" tool is
`FetchEvent.waitUntil`; its docs say it exists so the host "shouldn't terminate
the application if it wants that work to complete" — i.e. **without it, the host
may terminate before the work runs.**

## Why BLOCK is worse than ALLOW

Same buggy `emit()`, opposite exposure — because of what happens *after* `emit()`:

- **ALLOW** (`cdn.ts` ~133): handler does `await fetch(request, { backend })` to the
  origin — a real round-trip that keeps the instance alive and pumps the event
  loop, so the detached work resolves *incidentally*. Effectively safe today.
- **BLOCK** (`cdn.ts` ~128): handler does `return new Response(...)` immediately —
  nothing keeps the instance alive, so the detached work can be cut off. This is
  the path that actually drops, and it's the bot-block events the pipeline exists
  to capture.

## Scope — what's exposed

Both Fastly analytics transports share the shape:

1. **`FastlyLogTransport`** — first `emit()` defers `log()` behind an
   `await import("fastly:logger")` inside a detached promise.
2. **`HttpAnalyticsTransport`** (the Fastly **default** when `logEndpoint` is unset)
   — detached `fetch()` to the relay. *Wider* drop window than the import, since
   it's a full network round-trip.

Billing/`verifyAndRecordEvent` is **not** affected — it awaits on Fastly. The gap
is specific to fire-and-forget analytics emit.

## Evidence / certainty (read before "fixing")

- **Confirmed (real runtime, Viceroy):** the current code defers the `log()` call to
  *after* the response is sent; an on-path version logs *before* it. Ordering is real.
- **NOT reproduced:** Viceroy delivered the detached log **every time** — it drains
  pending promises before reclaiming the instance. So the local emulator is too
  lenient to demonstrate an actual drop. The drop depends on the **production edge
  host's** teardown policy, which Viceroy does not replicate.
- **Therefore:** treat this as a *latent, well-grounded reliability risk*, not a
  confirmed observable bug. **The real gate is a production spot-check** (Phase 8's
  "Done when"): deploy with a `bot_events` → S3 endpoint, trigger a BLOCK, confirm
  the row lands in S3 / Tinybird. Until that's run, severity is unknown.

---

## The fix that was drafted (and reverted)

Targeted fix for the **log path only** — make `log()` synchronous and on-path so
delivery no longer depends on post-response execution. Cheap (~15 lines, one awaited
builtin import per instance; no public API change). It does **not** address the
HTTP-fallback path.

1. `src/analytics/types.ts` — add optional `ready?(): Promise<void>` to
   `AnalyticsTransport`.
2. `src/analytics/transport.ts` — `FastlyLogTransport` eagerly starts
   `import("fastly:logger")` + constructs the `Logger` in its constructor, stored as
   `initPromise`; `ready()` returns it; `emit()` keeps a synchronous fast path (hit
   once warmed) plus a deferred fallback.
3. `src/index.ts` — in `fastlyHandleRequests`, after building the instance and before
   `handleFastlyRequest`: `await instance.analyticsTransport.ready?.();` (no-op for
   Http/Noop, which don't implement `ready`).
4. `tests/analytics/transport.test.ts` — add a no-`ctx` test asserting `log()` fires
   synchronously during `emit()` after `ready()`; also fix two stale constructions
   that omit the now-required `endpoint`.

The exact patch is saved alongside this work; regenerate with the steps above.
Build + 125 unit tests passed with it applied.

### Decide between two approaches when you return

- **(A) On-path log (the drafted fix).** Closes the **log transport** path only.
  Leaves the HTTP fallback best-effort. Lowest cost. Good enough if native logging
  is the only Fastly analytics path we care about.
- **(B) Real keep-alive at the root.** Thread the `FetchEvent`'s `waitUntil` through
  `fastlyHandleRequests` (API change — it doesn't receive `event` today), so *all*
  detached analytics work (log import **and** relay fetch) is held until it settles.
  Closes both paths. More invasive. The alternative — blocking on the relay POST
  before responding — adds request latency and defeats the firehose-off-backend goal,
  so prefer `waitUntil` over blocking.

Recommended: do the **production spot-check first** to learn whether a drop even
happens; if it does, ship (A) for the log path and (B) only if the HTTP fallback
must also be reliable.

## Checklist for later

- [ ] Production spot-check: BLOCK on real Fastly → row in S3/Tinybird? (settles severity)
- [ ] If dropping: apply on-path log fix (A) for `FastlyLogTransport`.
- [ ] Decide whether the HTTP relay fallback on Fastly must be reliable too → (B).
- [ ] Update `roadmap.md` Phase 8 and the PR/branch description to state what's
      reliable (native logging, once on-path) vs. best-effort (HTTP fallback).
