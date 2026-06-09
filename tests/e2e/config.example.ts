// Copy this file to config.ts and fill in your values
// config.ts is gitignored

export interface EnvironmentConfig {
  clientId: string;
  clientSecret?: string;
  resourceUrl: string;
  baseUrl: string;
  // How the Worker at `resourceUrl` is actually configured. enforcement.test.ts
  // derives its TEST_MODE from these, so the test always validates the mode the
  // deployment really runs (no TEST_ENV/TEST_MODE mismatch). Default if omitted:
  // enforcement "observe", botDetection false.
  enforcement?: "observe" | "enforce" | "disabled";
  botDetection?: boolean;
  // Analytics e2e (cloudflare-e2e.ts / analytics-smoke.ts) resolve these from the
  // selected TEST_ENV: where to query rows, and which merchant to filter by.
  // (TB_ADMIN_TOKEN stays an env var — it's a secret.)
  tinybirdUrl?: string; // Tinybird query host (local: http://localhost:7181)
  merchantSystemUrn?: string; // merchant URN behind this env's worker (see /__debug)
}

export const ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  local: {
    clientId: "",
    clientSecret: "",
    resourceUrl: "http://127.0.0.1:7676/article",
    baseUrl: "http://localhost:8000",
  },
  // Cloudflare demo worker (wrangler dev on :8788) in front of the local
  // origin (:8789). This is the default TEST_ENV for enforcement.test.ts.
  "local-cloudflare": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "http://127.0.0.1:8788/articles/welcome",
    baseUrl: "http://localhost:8000",
    enforcement: "observe",
    botDetection: false,
    tinybirdUrl: "http://localhost:7181",
    merchantSystemUrn: "urn:stc:merchant:system:<your-local-merchant>",
  },
  "sandbox-compute": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://stc-fastly-demo.edgecompute.app",
    baseUrl: "https://api-connect.sbx.supertab.co",
  },
  "sandbox-cloudfront": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://d2rpbtym810nyy.cloudfront.net",
    baseUrl: "https://api-connect.sbx.supertab.co",
  },
  "sandbox-vcl": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://supertab-rsl.global.ssl.fastly.net",
    baseUrl: "https://api-connect.sbx.supertab.co",
  },
  "production-compute": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://stc-fastly-demo.edgecompute.app",
    baseUrl: "https://api-connect.supertab.co",
  },
  "production-cloudfront": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://d2rpbtym810nyy.cloudfront.net",
    baseUrl: "https://api-connect.supertab.co",
  },
  // Deployed Cloudflare Worker (demos/cloudflare, `wrangler deploy --env
  // production`) on contribute.app via Workers Routes. Run with
  // TEST_ENV=production-cloudflare to exercise the live deployment. The mode
  // here MUST match how that worker is actually deployed.
  "production-cloudflare": {
    clientId: "",
    clientSecret: "",
    resourceUrl: "https://www.contribute.app",
    baseUrl: "https://api-connect.supertab.co",
    enforcement: "observe",
    botDetection: false,
    tinybirdUrl: "https://api.eu-central-1.aws.tinybird.co",
    merchantSystemUrn: "urn:stc:merchant:system:<prod-merchant>",
  },
  // Example: the same site deployed in STRICT (ENFORCE) mode. Add an entry like
  // this for a strict deployment and run `TEST_ENV=<name> npm test` — the test
  // validates strict behavior (bot/no-token → 401, valid token → 200) against
  // the live worker, no overrides.
  // "contribute-strict": {
  //   clientId: "",
  //   clientSecret: "",
  //   resourceUrl: "https://www.contribute.app",
  //   baseUrl: "https://api-connect.supertab.co",
  //   enforcement: "enforce",
  //   botDetection: true,
  // },
};
