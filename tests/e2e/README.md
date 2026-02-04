# End-to-End Tests

Integration tests for verifying SDK enforcement behavior against a running server.

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
  MERCHANT_SYSTEM_URN,
  MERCHANT_API_KEY,
  "origin",
  {
    enableRSL: true,
    // For bot-detection modes:
    botDetector: defaultBotDetector,
    enforcement: EnforcementMode.SOFT,  // or STRICT
  }
)
```

Then rebuild and restart the server before running tests.