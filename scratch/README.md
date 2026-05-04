# scratch/

Strategic / narrative documentation for the SDK v2.0 work. **No
executable scripts here anymore** — those were consolidated into
`tests/e2e/` (see `tests/e2e/README.md`).

| File | Purpose |
|------|---------|
| `HANDOFF.md` | File/code-level "what shipped" for SDK v2.0 (Phase 1) |
| `ANALYTICS_MVP_STATE.md` | Strategic / forward-looking; phased plan, deferred work, Phase 2 / 2.5 outcomes |
| `analytics-mvp-implementation-followup.md` | Chronological narrative of how decisions were reached |

## Where the harnesses live now

| Harness | Location | Purpose |
|---------|----------|---------|
| Cloudflare analytics pipeline E2E (workerd, all 6 emit branches) | `tests/e2e/cloudflare-e2e.ts` | Verifies Tinybird rows land correctly through the production runtime. |
| Read-side multi-tenancy (Tinybird JWT `fixed_params`) | `tests/e2e/read-isolation.ts` | Verifies per-merchant read isolation. |

The earlier `scratch/local-emit.ts` was retired in the consolidation —
its six-branch coverage now runs through the Cloudflare harness in
workerd, so we're testing the actual production runtime instead of
plain Node. See `ANALYTICS_MVP_STATE.md` for the full story.
