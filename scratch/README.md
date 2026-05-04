# scratch/

Working notes for the SDK v2.0 / bot traffic analytics work. Two files,
each with a clear job. Read this first to know which one to open.

| File | Open this when... | Updated when... |
|------|-------------------|-----------------|
| **`STATE.md`** | You want to know **what's built, where it lives, or how to run it.** Day-to-day reference: file inventory, Tinybird schema, SDK config, cheatsheet, deferred work, dropped ideas, open questions. | A phase ships, a deferred item gets a trigger, a command in the cheatsheet stops working, or a piece of state changes (schema, env vars, ports). |
| **`DECISIONS.md`** | You want to know **why we chose X over Y** at some point in the past. Chronological narrative of the non-obvious calls (`Step 1..N`). Rarely needed week-to-week. | A new non-obvious decision gets made. Append a new `Step N` — don't retroactively edit prior steps; their value is being a snapshot of what was decided *at the time*. |

The runnable test harnesses live in `tests/e2e/` (see
`tests/e2e/README.md`). Strategic source docs that predate this work —
`analytics-mvp-build-plan.md` and `supertab-tinybird-setup.md` — are
referenced from `DECISIONS.md` for original intent; both are partially
superseded.

## Conventions

- These files are gitignored (the whole `scratch/` directory is). They
  exist for the developer's own reference, not as project documentation.
- `STATE.md` should be **kept current** — stale state is worse than no
  state.
- `DECISIONS.md` should be **append-only** — old steps don't get
  retroactively rewritten when terminology changes (e.g.,
  `merchantId` → `merchantSystemUrn` is captured as `Step 13`, not by
  rewriting Steps 1–12 to use the new name).
