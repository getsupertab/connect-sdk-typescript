import { SupertabConnect } from "../../src/index";
import { ENVIRONMENTS, EnvironmentConfig } from "./config";

const TEST_ENV = process.env.TEST_ENV || "sandbox-cloudfront";
const config: EnvironmentConfig = ENVIRONMENTS[TEST_ENV] || ENVIRONMENTS["sandbox-cloudfront"];

SupertabConnect.setBaseUrl(config.baseUrl);

async function demo() {
  console.log("\n========================================");
  console.log("Supertab Connect SDK Demo");
  console.log("========================================");
  console.log(`Environment: ${TEST_ENV}`);
  console.log(`Resource URL: ${config.resourceUrl}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log("========================================\n");

  // Test 1: No token → 200
  console.log("1. GET with NO TOKEN");
  console.log("   Expected: 200 (passes through)\n");
  const res1 = await fetch(config.resourceUrl, {
    headers: { "User-Agent": "DemoClient/1.0" },
  });
  console.log(`   Status: ${res1.status}`);
  console.log("");

  // Test 2: Valid token → 200
  console.log("2. GET with VALID TOKEN");
  console.log("   Expected: 200\n");
  const validToken = await SupertabConnect.obtainLicenseToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret ?? "",
    resourceUrl: config.resourceUrl,
    debug: false,
  });
  const res2 = await fetch(config.resourceUrl, {
    headers: {
      "User-Agent": "DemoClient/1.0",
      Authorization: `License ${validToken}`,
    },
  });
  console.log(`   Status: ${res2.status}`);
  console.log("");

  // Test 3: Invalid token → 401 with headers
  console.log("3. GET with INVALID TOKEN");
  console.log("   Expected: 401 with WWW-Authenticate header\n");
  const res3 = await fetch(config.resourceUrl, {
    headers: {
      "User-Agent": "DemoClient/1.0",
      Authorization: "License invalid.token.here",
    },
  });
  console.log(`   Status: ${res3.status}`);
  console.log("   Headers:");
  console.log(`     WWW-Authenticate: ${res3.headers.get("WWW-Authenticate")}`);
  console.log(`     Link: ${res3.headers.get("Link")}`);
  console.log("");

  console.log("========================================");
  console.log("Demo Complete");
  console.log("========================================\n");
}

demo().catch(console.error);
