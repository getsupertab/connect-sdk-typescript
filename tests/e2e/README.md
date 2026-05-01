# End-to-End Tests

Integration tests for verifying SDK enforcement behavior against a running server.

## Files

| File | What it does | How to run |
|------|--------------|-----------|
| `enforcement.test.ts` | Vitest suite — Worker HTTP behavior (status codes, headers, license token verification) | `npm test` |
| `cloudflare-e2e.ts` | Standalone harness — analytics pipeline (Tinybird rows land correctly through workerd, all 6 SDK emit branches) | `TB_ADMIN_TOKEN=… npx tsx tests/e2e/cloudflare-e2e.ts` |
| `read-isolation.ts` | Standalone harness — Tinybird JWT `fixed_params` read-side multi-tenancy | `TB_ADMIN_TOKEN=… npx tsx tests/e2e/read-isolation.ts` |
| `demo.ts` / `production_test_script.ts` | Manual / ad-hoc | per script |

The two `.ts` harnesses live alongside the vitest tests but aren't
picked up by `npm test` (only `*.test.ts` is). They're standalone tsx
scripts because their orchestration (preflight, scenario sweep, polling
Tinybird) doesn't fit cleanly into vitest's it/expect shape.

## Coverage map

| Layer | Covered by |
|-------|------------|
| Worker HTTP behavior (status / headers / license verification) | `enforcement.test.ts` |
| SDK emit → Tinybird write API → datasource | `cloudflare-e2e.ts` |
| Tinybird read pipe + JWT `fixed_params` | `read-isolation.ts` |

Each is the only test of its slice — they don't overlap.

## Setup

1. Copy the config template and add your credentials:
   ```bash
   cp tests/config.example.ts tests/config.ts
   ```

2. Fill in `tests/config.ts` with your environment credentials (clientId, clientSecret, etc.)

## Test Modes

Tests are grouped by server configuration. Set `TEST_MODE` to match how your server is configured:

| Mode | Enforcement | Bot Detection | Description |
|------|-------------|---------------|-------------|
| `disabled` | DISABLED | - | Everything passes |
| `soft-no-bot-detection` | SOFT | OFF | Validate tokens only |
| `strict-no-bot-detection` | STRICT | OFF | Validate tokens only |
| `soft-bot-detection` | SOFT | ON | Signal bots, validate tokens |
| `strict-bot-detection` | STRICT | ON | Block bots, validate tokens |

## Running Tests

```bash
# Run with default mode (soft-no-bot-detection) against local server
npm test

# Run specific mode
TEST_MODE=soft-no-bot-detection npm test

# Run against different environment
TEST_ENV=sandbox-compute TEST_MODE=soft-bot-detection npm test

# Watch mode
npx vitest
```

## Configuring the Server

Update your Fastly demo (`demos/fastly/src/index.js`) to match the test mode:

```javascript
SupertabConnect.fastlyHandleRequests(
  event.request,
  MERCHANT_API_KEY,
  "origin",
  {
    enableRSL: true,
    merchantSystemUrn: MERCHANT_SYSTEM_URN,
    // For bot-detection modes:
    botDetector: defaultBotDetector,
    enforcement: EnforcementMode.OBSERVE,  // or ENFORCE
  }
)
```

Then rebuild and restart the server before running tests.