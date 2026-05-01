import {
	SupertabConnect,
	EnforcementMode,
	defaultBotDetector,
} from "@getsupertab/supertab-connect-sdk";

interface DemoEnv {
	MERCHANT_API_KEY: string;
	MERCHANT_ID: string;
	SUPERTAB_ANALYTICS_TOKEN?: string;
	SUPERTAB_ANALYTICS_ENDPOINT?: string;
	SUPERTAB_BASE_URL?: string;
	MERCHANT_SYSTEM_URN?: string;
	/** Upstream origin URL for the SDK's ALLOW/OBSERVE pass-through. The
	 *  Worker URL stays as `request.url` (so token `aud` matches the
	 *  publisher URL); the SDK fetches forwarded traffic from this URL
	 *  instead. Path / query / method / headers / body preserved. */
	ORIGIN_URL?: string;
	/** Test-only flag. When "true", the Worker honors X-Test-Enforcement
	 *  and X-Test-Bot-Detection request headers. Used by tests/cloudflare-e2e.ts
	 *  to walk all SDK emission branches in one wrangler run. Keep unset
	 *  in any deployed config. */
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
		}

		const incoming = new URL(request.url);

		// Diagnostic endpoint — returns what env values the Worker is seeing.
		// Helpful when .dev.vars changes don't appear to take effect.
		if (incoming.pathname === "/__debug") {
			return new Response(JSON.stringify({
				ALLOW_TEST_OVERRIDES: env.ALLOW_TEST_OVERRIDES,
				MERCHANT_ID: env.MERCHANT_ID,
				ORIGIN_URL: env.ORIGIN_URL,
				SUPERTAB_BASE_URL: env.SUPERTAB_BASE_URL,
				has_analytics_token: !!env.SUPERTAB_ANALYTICS_TOKEN,
				headers_seen: {
					"x-test-enforcement": request.headers.get("X-Test-Enforcement"),
					"x-test-bot-detection": request.headers.get("X-Test-Bot-Detection"),
				},
			}, null, 2), { headers: { "Content-Type": "application/json" } });
		}

		// RSL Worker behavior (rsl_license.md): /license.xml proxies straight
		// to the local backend; CAP/SDK is not involved on this path in prod
		// because it sits on a separate Worker route.
		if (incoming.pathname === "/license.xml") {
			return proxyLicenseXml(env);
		}

		// Defaults match the user's enforcement-test setup: OBSERVE mode,
		// bot detection off. Tests can override per-request when
		// ALLOW_TEST_OVERRIDES=true (see tests/cloudflare-e2e.ts).
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
			analyticsEnabled: !!env.SUPERTAB_ANALYTICS_TOKEN,
			analyticsEndpoint: env.SUPERTAB_ANALYTICS_ENDPOINT,
			originUrl: env.ORIGIN_URL,
		});
	},
};
