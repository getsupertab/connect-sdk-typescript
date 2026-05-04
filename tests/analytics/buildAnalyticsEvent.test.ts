import { describe, it, expect } from "vitest";
import { buildAnalyticsEvent } from "../../src/analytics/buildAnalyticsEvent";
import { Decision, SCHEMA_VERSION, TOKEN_OUTCOME_BY_REASON } from "../../src/analytics/types";
import { EnforcementMode, LicenseTokenInvalidReason } from "../../src/types";

const FIXED_TIME = new Date("2026-04-29T12:00:00.000Z");
const MERCHANT_SYSTEM_URN = "urn:stc:merchant:system:abc";
const REQUEST_ID = "req-123";

function makeRequest(opts?: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}): Request {
  return new Request(opts?.url ?? "https://example.com/articles/foo?x=1", {
    method: opts?.method ?? "GET",
    headers: opts?.headers ?? {},
  });
}

function ctx(extra?: Partial<Parameters<typeof buildAnalyticsEvent>[2]>) {
  return {
    merchantSystemUrn: MERCHANT_SYSTEM_URN,
    requestId: REQUEST_ID,
    sourceCdn: "cloudflare" as const,
    timestamp: FIXED_TIME,
    ...extra,
  };
}

const baseDecision: Decision = {
  hasToken: false,
  tokenOutcome: "absent",
  botVerdict: "human",
  finalAction: "allow",
  enforcementMode: EnforcementMode.OBSERVE,
};

describe("buildAnalyticsEvent", () => {
  it("returns an event matching the Tinybird bot_events_raw shape", () => {
    const req = makeRequest({
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://example.com/",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const event = buildAnalyticsEvent(req, baseDecision, ctx({ clientIp: "1.2.3.4" }));

    expect(event).toEqual({
      merchant_system_urn: MERCHANT_SYSTEM_URN,
      timestamp: "2026-04-29T12:00:00.000Z",
      request_id: REQUEST_ID,
      schema_version: SCHEMA_VERSION,
      source_cdn: "cloudflare",
      user_agent: "Mozilla/5.0",
      client_ip: "::ffff:1.2.3.4",
      path: "/articles/foo",
      method: "GET",
      referer: "https://example.com/",
      accept_language: "en-US,en;q=0.9",
      has_token: false,
      token_outcome: "absent",
      bot_detector_result: "human",
      final_action: "allow",
      enforcement_mode: "observe",
    });
  });

  describe("final_action branches", () => {
    it.each(["allow", "observe", "block"] as const)(
      "passes through final_action=%s",
      (finalAction) => {
        const event = buildAnalyticsEvent(
          makeRequest(),
          { ...baseDecision, finalAction },
          ctx()
        );
        expect(event.final_action).toBe(finalAction);
      }
    );
  });

  describe("enforcement_mode mapping", () => {
    it.each([
      [EnforcementMode.OBSERVE, "observe"],
      [EnforcementMode.ENFORCE, "enforce"],
      [EnforcementMode.DISABLED, "disabled"],
    ] as const)("maps %s to wire value %s", (mode, wire) => {
      const event = buildAnalyticsEvent(
        makeRequest(),
        { ...baseDecision, enforcementMode: mode },
        ctx()
      );
      expect(event.enforcement_mode).toBe(wire);
    });
  });

  describe("token_outcome mapping from LicenseTokenInvalidReason", () => {
    it.each(Object.entries(TOKEN_OUTCOME_BY_REASON))(
      "%s → %s",
      (reason, expectedOutcome) => {
        const event = buildAnalyticsEvent(
          makeRequest(),
          {
            ...baseDecision,
            hasToken: true,
            tokenOutcome: TOKEN_OUTCOME_BY_REASON[reason as LicenseTokenInvalidReason],
            finalAction: "block",
          },
          ctx()
        );
        expect(event.token_outcome).toBe(expectedOutcome);
      }
    );
  });

  describe("bot_detector_result branches", () => {
    it.each(["human", "unverified_bot", "suspicious", "unknown", "verified_bot"] as const)(
      "passes through botVerdict=%s",
      (botVerdict) => {
        const event = buildAnalyticsEvent(
          makeRequest(),
          { ...baseDecision, botVerdict },
          ctx()
        );
        expect(event.bot_detector_result).toBe(botVerdict);
      }
    );
  });

  describe("client_ip normalization", () => {
    it("maps IPv4 to IPv6-mapped form", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx({ clientIp: "192.0.2.1" }));
      expect(event.client_ip).toBe("::ffff:192.0.2.1");
    });

    it("passes IPv6 through", () => {
      const event = buildAnalyticsEvent(
        makeRequest(),
        baseDecision,
        ctx({ clientIp: "2001:db8::1" })
      );
      expect(event.client_ip).toBe("2001:db8::1");
    });

    it("emits :: for missing client_ip", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx({ clientIp: undefined }));
      expect(event.client_ip).toBe("::");
    });

    it("emits :: for invalid client_ip", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx({ clientIp: "not-an-ip" }));
      expect(event.client_ip).toBe("::");
    });
  });

  describe("request field extraction", () => {
    it("extracts pathname from URL with query string", () => {
      const event = buildAnalyticsEvent(
        makeRequest({ url: "https://x.test/foo/bar?baz=1#frag" }),
        baseDecision,
        ctx()
      );
      expect(event.path).toBe("/foo/bar");
    });

    it("yields empty path for unparseable URL", () => {
      const req = { url: "not a url", method: "GET", headers: new Headers() } as unknown as Request;
      const event = buildAnalyticsEvent(req, baseDecision, ctx());
      expect(event.path).toBe("");
    });

    it("captures method", () => {
      const event = buildAnalyticsEvent(makeRequest({ method: "POST" }), baseDecision, ctx());
      expect(event.method).toBe("POST");
    });

    it("defaults missing headers to empty strings", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx());
      expect(event.user_agent).toBe("");
      expect(event.referer).toBe("");
      expect(event.accept_language).toBe("");
    });
  });

  describe("source_cdn", () => {
    it.each(["cloudflare", "fastly", "cloudfront"] as const)(
      "stamps source_cdn=%s",
      (sourceCdn) => {
        const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx({ sourceCdn }));
        expect(event.source_cdn).toBe(sourceCdn);
      }
    );
  });

  describe("has_token", () => {
    it.each([true, false])("passes through hasToken=%s", (hasToken) => {
      const event = buildAnalyticsEvent(
        makeRequest(),
        { ...baseDecision, hasToken },
        ctx()
      );
      expect(event.has_token).toBe(hasToken);
    });
  });
});
