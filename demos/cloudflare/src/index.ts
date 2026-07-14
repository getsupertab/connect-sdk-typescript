import {
	SupertabConnect,
	EnforcementMode,
	defaultBotDetector,
} from "@getsupertab/supertab-connect-sdk";

interface DemoEnv {
	MERCHANT_API_KEY: string;
	MERCHANT_SYSTEM_URN: string;
	SUPERTAB_BASE_URL?: string;
	/** Base URL of the analytics ingest service (the dedicated relay host). Falls
	 *  back to SUPERTAB_BASE_URL when unset — the backend serves /ingest/events as
	 *  a compatibility bridge. Set this to the standalone ingest host to exercise
	 *  the split (e.g. https://ingest-connect.sbx.supertab.co). */
	SUPERTAB_ANALYTICS_BASE_URL?: string;
	/** Upstream origin URL for the SDK's ALLOW/OBSERVE pass-through. The
	 *  Worker URL stays as `request.url` (so token `aud` matches the
	 *  publisher URL); the SDK fetches forwarded traffic from this URL
	 *  instead. Path / query / method / headers / body preserved. */
	ORIGIN_URL?: string;
	/** Relay analytics emission ("true"/"false"). Relay model: the SDK POSTs
	 *  to the backend `${SUPERTAB_BASE_URL}/ingest/events` with the merchant
	 *  API key as a Bearer token — no separate analytics token/endpoint. The
	 *  backend stamps the merchant URN and forwards the event to Tinybird. */
	ANALYTICS_ENABLED?: string;
	/** Test-only flag. When "true", the Worker honors X-Test-Enforcement
	 *  and X-Test-Bot-Detection request headers. Used by tests/e2e/cloudflare-e2e.ts
	 *  and the enforcement test modes to walk SDK branches in one wrangler run.
	 *  Keep unset in any deployed config. */
	ALLOW_TEST_OVERRIDES?: string;
	/** Required by the SDK's Env type; allows arbitrary string vars. */
	[key: string]: string | undefined;
}

function parseEnforcement(s: string | null): EnforcementMode | undefined {
	if (!s) return undefined;
	switch (s.toLowerCase()) {
		case "observe": return EnforcementMode.OBSERVE;
		case "enforce": return EnforcementMode.ENFORCE;
		case "disabled": return EnforcementMode.DISABLED;
		default: return undefined;
	}
}

async function proxyLicenseXml(env: DemoEnv): Promise<Response> {
	if (!env.SUPERTAB_BASE_URL || !env.MERCHANT_SYSTEM_URN) {
		return new Response(
			"license.xml proxy not configured: set SUPERTAB_BASE_URL and MERCHANT_SYSTEM_URN",
			{ status: 500 },
		);
	}
	const upstream = `${env.SUPERTAB_BASE_URL}/merchants/systems/${env.MERCHANT_SYSTEM_URN}/license.xml`;
	const upstreamRes = await fetch(upstream, { method: "GET", redirect: "manual" });
	return new Response(upstreamRes.body, {
		status: upstreamRes.status,
		headers: upstreamRes.headers,
	});
}

export default {
	async fetch(request: Request, env: DemoEnv, ctx: ExecutionContext): Promise<Response> {
		if (env.SUPERTAB_BASE_URL) {
			SupertabConnect.setBaseUrl(env.SUPERTAB_BASE_URL);
			// Analytics defaults to the prod ingest service. Point it at this env's
			// ingest host (SUPERTAB_ANALYTICS_BASE_URL), falling back to the API host,
			// which serves /ingest/events as a bridge — so a local/sbx run never
			// leaks to prod.
			SupertabConnect.setAnalyticsBaseUrl(
				env.SUPERTAB_ANALYTICS_BASE_URL ?? env.SUPERTAB_BASE_URL,
			);
		}

		const incoming = new URL(request.url);

		// Diagnostic endpoint — returns what env values the Worker is seeing.
		// Helpful when .dev.vars changes don't appear to take effect. Gated on
		// ALLOW_TEST_OVERRIDES so it is NOT exposed on deployed (prod) configs.
		if (incoming.pathname === "/__debug" && env.ALLOW_TEST_OVERRIDES === "true") {
			return new Response(JSON.stringify({
				ALLOW_TEST_OVERRIDES: env.ALLOW_TEST_OVERRIDES,
				ANALYTICS_ENABLED: env.ANALYTICS_ENABLED,
				MERCHANT_SYSTEM_URN: env.MERCHANT_SYSTEM_URN,
				ORIGIN_URL: env.ORIGIN_URL,
				SUPERTAB_BASE_URL: env.SUPERTAB_BASE_URL,
				headers_seen: {
					"x-test-enforcement": request.headers.get("X-Test-Enforcement"),
					"x-test-bot-detection": request.headers.get("X-Test-Bot-Detection"),
				},
			}, null, 2), { headers: { "Content-Type": "application/json" } });
		}

		// /license.xml proxies straight to the local backend; the SDK is not
		// involved on this path (in prod it sits on a separate Worker route).
		if (incoming.pathname === "/license.xml") {
			return proxyLicenseXml(env);
		}

		// Defaults: OBSERVE mode, bot detection off. Tests can override
		// per-request when ALLOW_TEST_OVERRIDES=true.
		let enforcement: EnforcementMode = EnforcementMode.OBSERVE;
		let botDetector: typeof defaultBotDetector | undefined = undefined;

		if (env.ALLOW_TEST_OVERRIDES === "true") {
			// Reset the SDK singleton so per-request enforcement/botDetector
			// overrides actually take effect — the constructor returns the
			// cached instance otherwise (config supplied at first request
			// wins). Production deployments have a fixed config so the
			// singleton is fine; the test harness needs per-request swaps.
			SupertabConnect.resetInstance();

			const enfOverride = parseEnforcement(request.headers.get("X-Test-Enforcement"));
			if (enfOverride !== undefined) enforcement = enfOverride;
			if (request.headers.get("X-Test-Bot-Detection") === "true") {
				botDetector = defaultBotDetector;
			}
		}

		return SupertabConnect.cloudflareHandleRequests(request, env, ctx, {
			enforcement,
			botDetector,
			analyticsEnabled: env.ANALYTICS_ENABLED === "true",
			originUrl: env.ORIGIN_URL,
		});
	},
};
