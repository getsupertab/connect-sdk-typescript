# Rollout — preserved original authority on Fastly (edge + docs)

**For:** a session with access to `supertab-connect` (backend instructions) and the public
docs site. **Date:** 2026-09-17. **Author:** SDK-side session.
**Status:** SDK side implemented on `feat/fastly-original-authority`; everything below is
planned, not done.

## Context

Most Fastly deployments run a **VCL service → Compute service chain**. The VCL service
routes licensed traffic to Compute through a backend whose **Override host** is the Compute
service's `*.edgecompute.app` domain. Fastly applies `override_host` *after* VCL runs, so by
the time the SDK executes on Compute the inbound `Host` — and `request.url`'s authority — is
the Compute service's own hostname. The SDK cannot recover the viewer's host from inside
Compute; it has to be preserved upstream.

What that broke: license `aud` prefix matching (surfaces as `insufficient_scope` /
`invalid_license_audience`), the `/.well-known/supertab/status` probe's expected audience,
the `Link: rel="license"` URL, and the `host` column on analytics rows.

The pre-existing mitigation is Step 3 of `cap_on_edge.md` — the `supertab-preserve-original-url`
**pass**-type snippet setting the full viewer URL into `X-Original-Request-Url`. It works,
but it is hand-installed, only runs on the `return(pass)` path, and prod capture samples do
not show it arriving.

## What the SDK now does

Resolution order, on the Fastly path only:

1. **`x-supertab-original-authority`** — a bare `host[:port]`, grafted onto the path and
   query the Compute service observed. Renameable via the new
   `options.originalAuthorityHeader`; the default is used when it is unset or blank.
2. **`x-original-request-url`** — the existing full-URL header, unchanged. When both are
   present the authority header wins for the host, and the forwarded URL supplies the
   **scheme** (then `x-forwarded-proto`, then `https`).
3. **`request.url`** — compute-only deployments, where the authority is already correct.

A value that is not a bare authority (a full URL, a path, userinfo, a comma-joined hop list,
whitespace, over 255 chars) is ignored and resolution falls through, rather than throwing or
parsing into a plausible wrong host. Analytics `host` now comes from the reconstructed URL,
and anything under `x-supertab-*` is kept out of the `header_names` signal.

**The SDK trusts the header unconditionally** — it cannot distinguish a VCL hop from a
direct caller. That is a deliberate choice for interface simplicity (the same trade-off
already made for `Fastly-Client-IP`, see `fastly-capture-handoff.md`), and it moves the
entire trust boundary into the VCL service. Hence the `unset` below is required, not
optional.

## Rollout order

The header is **additive**. Older SDKs ignore it, and chains already running
`x-original-request-url` keep working through precedence 2 — so neither side blocks the
other and no customer is forced to migrate. Ship the SDK release first so the header has a
consumer, then the instruction change; either order is safe.

## Change 1 — `supertab-connect` customer instructions

File: `backend/src/services/cdn/orchestrators/fastly/instructions/cap_on_edge.md`.

**Step 2** (`supertab-cap-reroute`, type `recv`, priority 99/100) — replace the snippet body:

```vcl
# Only this service may set the Supertab edge headers: drop any client-supplied
# copy before anything reads them, so a viewer cannot choose its own audience.
unset req.http.X-Supertab-Original-Authority;
unset req.http.X-Original-Request-Url;

# Look for the presence of the License header
if (req.http.Authorization ~ "^License ") {
  # Preserve the viewer's host — the Compute host's Override host replaces it downstream
  set req.http.X-Supertab-Original-Authority = req.http.host;
  # Set the backend to your dedicated Compute service
  set req.backend = F_supertab_compute_validator;
  return (pass);
}
```

Two deliberate choices:

- **`recv`, not the Step 3 `pass` snippet, and `req.http.` not `bereq.http.`** A `pass`-type
  snippet only runs on the `return(pass)` path, so any other route to Compute would lose the
  header. `vcl_recv` also runs before any host rewrite this service does of its own.
- **The `unset` is unconditional and first.** It is the direct analogue of
  `delete request.headers["x-original-request-url"];` in
  `cloudfront/instructions/cap_on_edge.md:148` (rationale at :163). Without it a
  client-supplied `x-supertab-original-authority` is an ENFORCE-mode audience bypass: a
  token legitimately minted for `attacker.example` would pass the audience check while
  fetching the merchant's content.

**Step 3** (`supertab-preserve-original-url`, type `pass`, priority 100) — body unchanged.
Add one sentence to its prose: it remains the source of the URL **scheme** for chains
running both headers, and remains the whole contract for SDKs older than this release.

**Step 8 troubleshooting** — alongside the existing `insufficient_scope` note (currently
`cap_on_edge.md:157`): "If the Compute service rejects the audience with
`insufficient_scope`, confirm both `X-Supertab-Original-Authority` (Step 2) and
`X-Original-Request-Url` (Step 3) reach the Compute service."

### Test fallout in that repo

Instruction text is asserted in Python tests; both need the new header added:

- `backend/src/tests/handlers/deployments/test_manual_deployment.py` — the Fastly content
  test asserts on `"preserves the original request url"`, `"x-original-request-url"` and
  `"stc-backend"`. Keep those strings intact; add an assertion for
  `x-supertab-original-authority`.
- `backend/src/tests/services/cdn/test_deployment_service.py` — mirrors the CloudFront
  `delete request.headers[...]` assertion; add the Fastly `unset` equivalent.

Note there is **nothing to change in the orchestrator code**: `get_cap_on_edge_steps` for
Fastly raises `NotImplementedError` (CAP on edge is manual-only there), and the only snippet
created programmatically is the `recv` license-path rewrite.

## Change 2 — public docs (`connect-docs.supertab.co`)

Mirror the README's new "VCL → Compute chains" subsection, and add
`originalAuthorityHeader` to the Fastly options table. Make two things explicit: the header
name only needs changing on a collision with something already on the merchant's service,
and a custom name should keep the `x-supertab-` prefix so it stays out of analytics
`header_names`. Carry over the warning that a **direct** Compute deployment has no VCL layer
to strip a client-supplied copy and should not install the header handling.

## Verification after the edge change lands

- `curl -H 'Authorization: License <token>' https://<viewer-host>/<licensed-path>` returns
  `Link: <https://<viewer-host>/license.xml>`, not `…edgecompute.app…`, and no longer
  `insufficient_scope`.
- The `/.well-known/supertab/status` probe verifies against the viewer origin.
- Tinybird, scoped to rows after the deploy timestamp and `source_cdn = 'fastly'`: `host`
  shows viewer hosts rather than the `*.edgecompute.app` domain, and `header_names` contains
  no `x-supertab-*` entry.
- Spoof check: send `x-supertab-original-authority: evil.example` through the **VCL**
  hostname and confirm the `unset` strips it (the `Link` still names the viewer host).
  Sending it directly to the `*.edgecompute.app` endpoint will be honoured — that is the
  documented, accepted behaviour, and the reason the `unset` exists.
