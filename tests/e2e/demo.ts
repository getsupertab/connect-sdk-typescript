import { SupertabConnect } from "../../src/index";
import { ENVIRONMENTS, EnvironmentConfig } from "./config";
import * as readline from "readline";

// ── Config ──────────────────────────────────────────────────
const TEST_ENV = process.env.TEST_ENV || "sandbox-cloudfront";
const config: EnvironmentConfig =
  ENVIRONMENTS[TEST_ENV] || ENVIRONMENTS["sandbox-cloudfront"];

SupertabConnect.setBaseUrl(config.baseUrl);

// ── Colors ──────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
};

// ── Helpers ─────────────────────────────────────────────────
function waitForKey(prompt = "Press ENTER to continue..."): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`\n  ${c.dim}${prompt}${c.reset}`, () => {
      rl.close();
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function banner(step: number, total: number, title: string, emoji: string) {
  console.clear();

  const progress = Array.from({ length: total }, (_, i) =>
    i < step - 1 ? `${c.green}●${c.reset}` : i === step - 1 ? `${c.yellow}●${c.reset}` : `${c.dim}○${c.reset}`
  ).join(" ");

  console.log("");
  console.log(`  ${c.bold}${c.yellow}Supertab Connect — Demo${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
  console.log(`  ${progress}  ${c.dim}Step ${step}/${total}${c.reset}`);
  console.log("");
  console.log(`  ${emoji}  ${c.bold}${c.white}${title}${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
}

function botSays(text: string) {
  console.log(`\n  ${c.blue}🤖 Bot:${c.reset} ${c.italic}"${text}"${c.reset}`);
}

function showRequest(method: string, url: string, headers?: Record<string, string>) {
  console.log(`\n  ${c.cyan}→ ${method} ${url}${c.reset}`);
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      console.log(`    ${c.dim}${k}: ${v}${c.reset}`);
    }
  }
}

function showStatus(status: number, statusText?: string) {
  const color = status >= 200 && status < 300 ? c.green : c.red;
  const icon = status >= 200 && status < 300 ? "✅" : "❌";
  console.log(`\n  ${icon} ${color}${c.bold}${status}${c.reset} ${color}${statusText || ""}${c.reset}`);
}

function showHeader(name: string, value: string | null, highlight = false) {
  if (!value) return;
  const color = highlight ? c.yellow : c.dim;
  console.log(`  ${color}${name}: ${value}${c.reset}`);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function showJwtClaims(token: string) {
  const claims = decodeJwtPayload(token);
  if (!claims) return;

  console.log(`\n  ${c.magenta}${c.bold}Token claims:${c.reset}`);
  const display: [string, unknown][] = [
    ["sub", claims.sub],
    ["aud", claims.aud],
    ["scope", claims.scope],
    ["iat", claims.iat ? new Date((claims.iat as number) * 1000).toISOString() : undefined],
    ["exp", claims.exp ? new Date((claims.exp as number) * 1000).toISOString() : undefined],
  ];
  for (const [key, val] of display) {
    if (val !== undefined) {
      console.log(`    ${c.magenta}${key}:${c.reset} ${c.white}${val}${c.reset}`);
    }
  }
}

// ── Main Demo ───────────────────────────────────────────────
async function demo() {
  const TOTAL_STEPS = 6;

  console.clear();
  console.log("");
  console.log(`  ${c.bold}${c.yellow}╔══════════════════════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}        ${c.bold}Supertab Connect — Demo${c.reset}                 ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}╚══════════════════════════════════════════════════╝${c.reset}`);
  console.log("");
  console.log(`  ${c.dim}Environment:${c.reset}  ${TEST_ENV}`);
  console.log(`  ${c.dim}Resource:${c.reset}     ${config.resourceUrl}`);
  console.log(`  ${c.dim}API:${c.reset}          ${config.baseUrl}`);

  await waitForKey("Press ENTER to start the demo...");

  // ════════════════════════════════════════════════════════════
  // STEP 1: The world today — bots access freely
  // ════════════════════════════════════════════════════════════
  // banner(1, TOTAL_STEPS, "The world today — bots access freely", "🌍");
  // botSays("I want this article. Let me just... take it.");
  // await sleep(1000);

  // showRequest("GET", config.resourceUrl, {
  //   "User-Agent": "DemoBot/1.0",
  // });
  // await sleep(600);

  // const res0 = await fetch(config.resourceUrl, {
  //   headers: { "User-Agent": "DemoBot/1.0" },
  // });

  // showStatus(res0.status, "OK");
  // await sleep(400);

  // const body0 = await res0.text();
  // const preview0 = body0.substring(0, 200).replace(/\n/g, " ").trim();
  // console.log(`\n  ${c.dim}Body preview:${c.reset}`);
  // console.log(`  ${c.white}${preview0}${c.dim}...${c.reset}`);

  // console.log(`\n  ${c.red}${c.bold}No token. No license. No payment. Content served anyway.${c.reset}`);
  // botSays("Thanks for the free content! 😏");

  // console.log(`\n  ${c.dim}${"─".repeat(60)}${c.reset}`);
  // console.log(`  ${c.yellow}${c.bold}Now the publisher deploys Supertab Connect...${c.reset}`);
  // console.log(`  ${c.dim}(switch to UI to show deployment)${c.reset}`);

  // await waitForKey("Press ENTER after deployment is complete...");

  // ════════════════════════════════════════════════════════════
  // STEP 2: Bot arrives — gets 401
  // ════════════════════════════════════════════════════════════
  banner(2, TOTAL_STEPS, "Bot requests content — blocked!", "🚪");
  botSays("Let me grab that article again like I always do...");
  await sleep(1000);

  showRequest("GET", config.resourceUrl, {
    "User-Agent": "DemoBot/1.0",
  });
  await sleep(600);

  const res1 = await fetch(config.resourceUrl, {
    headers: { "User-Agent": "DemoBot/1.0" },
  });

  showStatus(res1.status, "Unauthorized");
  await sleep(400);
  console.log(`\n  ${c.dim}Response headers:${c.reset}`);
  showHeader("WWW-Authenticate", res1.headers.get("WWW-Authenticate"), true);
  showHeader("Link", res1.headers.get("Link"), true);

  botSays("Wait — what happened?! I was just here! ...what's this Link header?");

  await waitForKey();

  // ════════════════════════════════════════════════════════════
  // STEP 3: Bot discovers license.xml
  // ════════════════════════════════════════════════════════════
  banner(3, TOTAL_STEPS, "Bot discovers license.xml", "📄");

  // Extract license URL from Link header
  const linkHeader = res1.headers.get("Link") || "";
  const licenseUrlMatch = linkHeader.match(/<([^>]+)>/);
  const licenseUrl = licenseUrlMatch
    ? licenseUrlMatch[1]
    : `${new URL(config.resourceUrl).origin}/license.xml`;

  botSays("Let me follow that Link header...");
  await sleep(800);
  showRequest("GET", licenseUrl);
  await sleep(600);

  const res2 = await fetch(licenseUrl);
  showStatus(res2.status, "OK");
  await sleep(400);

  const licenseXml = await res2.text();

  // Show a trimmed, readable version
  console.log(`\n  ${c.dim}license.xml content:${c.reset}`);
  const lines = licenseXml.split("\n").map((l) => l.trimEnd());
  const displayLines = lines.filter((l) => l.trim().length > 0).slice(0, 20);
  for (const line of displayLines) {
    // Highlight key elements
    let styled = `  ${c.dim}${line}${c.reset}`;
    if (line.includes("<permits")) styled = `  ${c.cyan}${line}${c.reset}`;
    if (line.includes("<payment")) styled = `  ${c.yellow}${line}${c.reset}`;
    if (line.includes("<amount")) styled = `  ${c.green}${line}${c.reset}`;
    console.log(styled);
  }
  if (lines.length > 20) {
    console.log(`  ${c.dim}... (${lines.length - 20} more lines)${c.reset}`);
  }

  botSays("OK, I know the rules now. Let me get a license token.");

  await waitForKey();

  // ════════════════════════════════════════════════════════════
  // STEP 4: Bot gets a license token
  // ════════════════════════════════════════════════════════════
  banner(4, TOTAL_STEPS, "Bot gets a license token", "🔑");
  botSays("Let me authenticate and request a license...");
  await sleep(1000);

  console.log(`\n  ${c.dim}Requesting token via SDK:${c.reset}`);
  console.log(`    ${c.dim}clientId:${c.reset}     ${config.clientId}`);
  console.log(`    ${c.dim}resourceUrl:${c.reset}  ${config.resourceUrl}`);

  const token = await SupertabConnect.obtainLicenseToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret ?? "",
    resourceUrl: config.resourceUrl,
    debug: false,
  });

  console.log(`\n  ${c.green}${c.bold}✅ Token received!${c.reset}`);
  console.log(`\n  ${c.dim}JWT:${c.reset} ${token.substring(0, 40)}${c.dim}...${c.reset}`);

  showJwtClaims(token);

  botSays("Got my token! Now let me try that article again...");

  await waitForKey();

  // ════════════════════════════════════════════════════════════
  // STEP 5: Bot retries with token — 200 OK
  // ════════════════════════════════════════════════════════════
  banner(5, TOTAL_STEPS, "Bot retries with token — access granted!", "🎉");
  botSays("Same article, but this time I have my license...");
  await sleep(1000);

  showRequest("GET", config.resourceUrl, {
    "User-Agent": "DemoBot/1.0",
    Authorization: `License ${token.substring(0, 30)}...`,
  });
  await sleep(600);

  const res4 = await fetch(config.resourceUrl, {
    headers: {
      "User-Agent": "DemoBot/1.0",
      Authorization: `License ${token}`,
    },
  });

  showStatus(res4.status, "OK");
  await sleep(400);

  const contentType = res4.headers.get("Content-Type") || "";
  const body = await res4.text();
  const preview = body.substring(0, 200).replace(/\n/g, " ").trim();

  console.log(`\n  ${c.dim}Content-Type: ${contentType}${c.reset}`);
  console.log(`  ${c.dim}Body preview:${c.reset}`);
  console.log(`  ${c.white}${preview}${c.dim}...${c.reset}`);

  botSays("Content served! And this time the publisher gets paid.");

  await waitForKey();

  // ════════════════════════════════════════════════════════════
  // STEP 6: Invalid token — 401
  // ════════════════════════════════════════════════════════════
  banner(6, TOTAL_STEPS, "Bonus: what about a fake token?", "🛡️");
  botSays("What if someone tries to skip the license?");
  await sleep(1000);

  showRequest("GET", config.resourceUrl, {
    "User-Agent": "DemoBot/1.0",
    Authorization: "License not.a.real.token",
  });
  await sleep(600);

  const res5 = await fetch(config.resourceUrl, {
    headers: {
      "User-Agent": "DemoBot/1.0",
      Authorization: "License not.a.real.token",
    },
  });

  showStatus(res5.status, "Unauthorized");
  await sleep(400);
  console.log(`\n  ${c.dim}Response headers:${c.reset}`);
  showHeader("WWW-Authenticate", res5.headers.get("WWW-Authenticate"), true);

  botSays("Nope. Edge verification catches it in under 2ms.");

  await waitForKey();

  // ── Done ──────────────────────────────────────────────────
  console.clear();
  const allDone = Array.from({ length: TOTAL_STEPS }, () => `${c.green}●${c.reset}`).join(" ");
  console.log("");
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
  console.log(`  ${allDone}  ${c.green}${c.bold}All steps complete${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(60)}${c.reset}`);
  console.log("");
  console.log(`  ${c.bold}${c.yellow}╔══════════════════════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}        ${c.bold}Demo Complete${c.reset}                            ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}                                                  ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.dim}The full RSL lifecycle:${c.reset}                        ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.red}✗${c.reset} Before: bots access content for free        ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.green}✓${c.reset} Publisher deploys license + verification    ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.green}✓${c.reset} Agreement between bot operator & publisher ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.green}✓${c.reset} Bot discovers terms, gets licensed          ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.green}✓${c.reset} Edge verification in < 2ms                 ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}  ${c.green}✓${c.reset} Content served, publisher gets paid         ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}║${c.reset}                                                  ${c.bold}${c.yellow}║${c.reset}`);
  console.log(`  ${c.bold}${c.yellow}╚══════════════════════════════════════════════════╝${c.reset}`);
  console.log("");
}

demo().catch(console.error);