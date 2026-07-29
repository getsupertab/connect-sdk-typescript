import { verifyLicenseToken } from "../src/license";

const MOCK_ORIGIN = "http://localhost:9999";

async function main() {
  let raw = ""; for await (const c of process.stdin) raw += c;
  const scn = JSON.parse(raw);
  const input = scn.input as Record<string, string>;

  if (scn.surface === "verify") {
    const res = await verifyLicenseToken({ licenseToken: input.token ?? "", requestUrl: input.resource_url, supertabBaseUrl: MOCK_ORIGIN, debug: false });
    return print(res.valid ? { valid: true, reason: null } : { valid: false, reason: res.reason });
  }
  throw new Error(`unhandled surface: ${scn.surface}`);
}
function print(o: unknown) { process.stdout.write(JSON.stringify(o)); }
main().catch((e) => { console.error(e); process.exit(1); });
