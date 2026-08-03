import { verifyLicenseToken } from "../src/license";
import { SupertabConnect, defaultBotDetector, EnforcementMode } from "../src/index";
import { parseContentElements, selectTokenEndpoint, findServerlessUsageContent } from "../src/customer";

const MOCK_ORIGIN = "http://localhost:9999";

function rslHeaders(h: Headers) {
  const wa = h.get("www-authenticate") ?? "";
  const m = wa.match(/error="([^"]+)"/);
  const link = h.get("link") ?? "";
  const lm = link.match(/<([^>]+)>/);
  return {
    www_authenticate_error: m ? m[1] : null,
    link_license_url: lm ? lm[1] : null,
    x_rsl_status: h.get("x-rsl-status"),
    x_rsl_reason: h.get("x-rsl-reason"),
  };
}

async function main() {
  let raw = ""; for await (const c of process.stdin) raw += c;
  const scn = JSON.parse(raw);
  const input = scn.input as Record<string, any>;

  if (scn.surface === "verify") {
    const res = await verifyLicenseToken({ licenseToken: input.token ?? "", requestUrl: input.resource_url, supertabBaseUrl: MOCK_ORIGIN, debug: false });
    return print(res.valid ? { valid: true, reason: null } : { valid: false, reason: res.reason });
  }

  if (scn.surface === "enforce") {
    SupertabConnect.setBaseUrl(MOCK_ORIGIN);
    const inst = new SupertabConnect({
      apiKey: "test",
      enforcement: input.enforcement as EnforcementMode,
      botDetector: input.use_default_bot_detector ? defaultBotDetector : undefined,
    }, true);
    const req = input.request as { url: string; headers: Record<string, string> };
    const res: any = await inst.handleRequest(new Request(req.url, { headers: req.headers }));
    const headers = new Headers(res.headers ?? {});
    return print({ action: res.action, status: res.status ?? null, headers: rslHeaders(headers) });
  }

  if (scn.surface === "customer-match") {
    const blocks = parseContentElements(input.license_xml, false);
    const serverless = findServerlessUsageContent(blocks, input.resource_url, input.usage, false);
    if (serverless) {
      return print({ matched: true, matched_url_pattern: serverless.urlPattern, token_server: null, requires_token: false });
    }
    // Mirror obtainLicenseToken's mint path exactly: resolve the token endpoint via the
    // SDK's own selector. `matched` distinguishes a path-matched block from an
    // endpoint-only mint (STC-808 divergence: no block matches but the customer may still
    // hold an Active Agreement, so the backend is left to decide entitlement).
    const ep = selectTokenEndpoint(blocks, input.resource_url, MOCK_ORIGIN, false);
    if (!ep) {
      return print({ matched: false, matched_url_pattern: null, token_server: null, requires_token: false });
    }
    return print({
      matched: ep.matched,
      matched_url_pattern: ep.matched ? ep.scope : null,
      token_server: ep.server,
      requires_token: true,
    });
  }

  if (scn.surface === "customer-obtain") {
    SupertabConnect.setBaseUrl(MOCK_ORIGIN);
    try {
      const token = await SupertabConnect.obtainLicenseToken({
        clientId: input.client_id,
        clientSecret: input.client_secret,
        resourceUrl: input.resource_url,
        usage: input.usage,
      });
      return print({ outcome: token ? "mint" : "no_token" });
    } catch {
      return print({ outcome: "error" });
    }
  }

  throw new Error(`unhandled surface: ${scn.surface}`);
}
function print(o: unknown) { process.stdout.write(JSON.stringify(o)); }
main().catch((e) => { console.error(e); process.exit(1); });
