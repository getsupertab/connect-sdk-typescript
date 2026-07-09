import { describe, it, expect } from "vitest";
import { buildAnalyticsEvent } from "../../src/analytics/buildAnalyticsEvent";
import { Decision, SCHEMA_VERSION, TOKEN_OUTCOME_BY_REASON } from "../../src/analytics/types";
import { EnforcementMode, LicenseTokenInvalidReason } from "../../src/types";

const FIXED_TIME = new Date("2026-04-29T12:00:00.000Z");
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
    requestId: REQUEST_ID,
    sourceCdn: "cloudflare" as const,
    timestamp: FIXED_TIME,
    ...extra,
  };
}

const baseDecision: Decision = {
  hasToken: false,
  tokenOutcome: "absent",
  finalAction: "allow",
  enforcementMode: EnforcementMode.OBSERVE,
};

describe("buildAnalyticsEvent", () => {
  it("returns an event matching the relay bot_events_raw shape", () => {
    const req = makeRequest({
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://example.com/",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const event = buildAnalyticsEvent(req, baseDecision, ctx({ clientIp: "1.2.3.4" }));

    expect(event).toEqual({
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
      request_country: null,
      request_asn: null,
      tls_fingerprint: null,
      has_token: false,
      token_outcome: "absent",
      final_action: "allow",
      enforcement_mode: "observe",
      signature_agent: null,
      signature_input: null,
      signature: null,
      // Capture v2 — portable header signals (none of these headers were sent).
      sec_fetch_mode: null,
      sec_fetch_site: null,
      sec_fetch_dest: null,
      sec_fetch_user: null,
      sec_ch_ua: null,
      sec_ch_ua_mobile: null,
      sec_ch_ua_platform: null,
      accept: null,
      host: "example.com",
      has_cookies: false,
      header_names: ["accept-language", "referer", "user-agent"],
      query_length: 3,
      query_param_count: 1,
      query_suspicious: false,
      // Capture v2 — CDN plumbing (no cdnSignals in context → null).
      accept_encoding: null,
      http_protocol: null,
      tls_version: null,
      tls_cipher: null,
      tls_client_hello_length: null,
      tls_client_extensions_sha1: null,
      as_organization: null,
      client_tcp_rtt: null,
      cdn_verified_bot_category: null,
      request_priority: null,
      tls_fingerprint_ja4: null,
    });
  });

  it("does not include merchant_system_urn or bot_detector_result", () => {
    const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx());
    expect(event).not.toHaveProperty("merchant_system_urn");
    expect(event).not.toHaveProperty("bot_detector_result");
  });

  describe("classification signals from context", () => {
    it("passes through request_country / request_asn / tls_fingerprint", () => {
      const event = buildAnalyticsEvent(
        makeRequest(),
        baseDecision,
        ctx({ requestCountry: "DE", requestAsn: 3320, tlsFingerprint: "abc123" })
      );
      expect(event.request_country).toBe("DE");
      expect(event.request_asn).toBe(3320);
      expect(event.tls_fingerprint).toBe("abc123");
    });

    it("defaults to null when absent", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx());
      expect(event.request_country).toBeNull();
      expect(event.request_asn).toBeNull();
      expect(event.tls_fingerprint).toBeNull();
    });
  });

  describe("HTTP Message Signature headers", () => {
    it("reads signature_* from request headers", () => {
      const req = makeRequest({
        headers: {
          "signature-agent": "https://agent.example",
          "signature-input": "sig1=(...)",
          signature: "sig1=:abc:",
        },
      });
      const event = buildAnalyticsEvent(req, baseDecision, ctx());
      expect(event.signature_agent).toBe("https://agent.example");
      expect(event.signature_input).toBe("sig1=(...)");
      expect(event.signature).toBe("sig1=:abc:");
    });

    it("defaults signature_* to null when headers absent", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx());
      expect(event.signature_agent).toBeNull();
      expect(event.signature_input).toBeNull();
      expect(event.signature).toBeNull();
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

    it("is null when no CDN produced the request", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx({ sourceCdn: null }));
      expect(event.source_cdn).toBeNull();
    });
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

  describe("Capture v2 — portable header signals", () => {
    const browserHeaders = {
      "user-agent": "Mozilla/5.0",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1",
      "sec-ch-ua": '"Chromium";v="120", "Not(A:Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      accept: "text/html",
      cookie: "session=abc",
    };

    it("captures sec-fetch-* and client hints from a browser-like request", () => {
      const event = buildAnalyticsEvent(makeRequest({ headers: browserHeaders }), baseDecision, ctx());
      expect(event.sec_fetch_mode).toBe("navigate");
      expect(event.sec_fetch_site).toBe("none");
      expect(event.sec_fetch_dest).toBe("document");
      expect(event.sec_fetch_user).toBe("?1");
      expect(event.sec_ch_ua).toBe('"Chromium";v="120", "Not(A:Brand";v="24"');
      expect(event.sec_ch_ua_mobile).toBe("?0");
      expect(event.sec_ch_ua_platform).toBe('"macOS"');
      expect(event.accept).toBe("text/html");
      expect(event.has_cookies).toBe(true);
    });

    it("a curl-like request carries no sec-fetch / client hints / cookies", () => {
      const event = buildAnalyticsEvent(
        makeRequest({ headers: { "user-agent": "curl/8.0" } }),
        baseDecision,
        ctx()
      );
      expect(event.sec_fetch_mode).toBeNull();
      expect(event.sec_fetch_site).toBeNull();
      expect(event.sec_fetch_dest).toBeNull();
      expect(event.sec_fetch_user).toBeNull();
      expect(event.sec_ch_ua).toBeNull();
      expect(event.sec_ch_ua_mobile).toBeNull();
      expect(event.sec_ch_ua_platform).toBeNull();
      expect(event.has_cookies).toBe(false);
    });

    it("strips proxy/CDN-chain artifacts from header_names, keeping only client headers", () => {
      const event = buildAnalyticsEvent(
        makeRequest({
          headers: {
            "user-agent": "Mozilla/5.0",
            "accept-language": "en-US",
            // Fastly service-chain / proxy artifacts — must not appear.
            "cdn-loop": "fastly",
            "x-varnish": "123456",
            via: "1.1 varnish",
            "surrogate-key": "abc",
            "surrogate-control": "max-age=0",
            "fastly-client-ip": "203.0.113.9",
          },
        }),
        baseDecision,
        ctx()
      );
      expect(event.header_names).toEqual(["accept-language", "user-agent"]);
    });

    it("falls back to the URL host when the Host header is unavailable", () => {
      const event = buildAnalyticsEvent(
        makeRequest({ url: "https://pub.example.com/a" }),
        baseDecision,
        ctx()
      );
      expect(event.host).toBe("pub.example.com");
    });

    it("truncates accept and sec-ch-ua to 512 chars", () => {
      const long = "a".repeat(600);
      const event = buildAnalyticsEvent(
        makeRequest({ headers: { accept: long, "sec-ch-ua": long } }),
        baseDecision,
        ctx()
      );
      expect(event.accept).toHaveLength(512);
      expect(event.sec_ch_ua).toHaveLength(512);
    });
  });

  describe("Capture v2 — header_names", () => {
    it("lowercases, dedupes and sorts the header-name set", () => {
      const event = buildAnalyticsEvent(
        makeRequest({ headers: { "User-Agent": "x", Accept: "y", Referer: "z" } }),
        baseDecision,
        ctx()
      );
      expect(event.header_names).toEqual(["accept", "referer", "user-agent"]);
    });

    it("strips edge-injected headers across all CDNs", () => {
      const event = buildAnalyticsEvent(
        makeRequest({
          headers: {
            "user-agent": "x",
            // Cloudflare
            "cf-connecting-ip": "1.2.3.4",
            "cf-ray": "abc",
            // Fastly
            "fastly-client-ip": "1.2.3.4",
            "fastly-client-ja3": "deadbeef",
            // CloudFront
            "cloudfront-viewer-country": "DE",
            "cloudfront-viewer-ja3-fingerprint": "abc",
            // shared / SDK routing
            "x-forwarded-for": "1.2.3.4",
            "x-real-ip": "1.2.3.4",
            "x-original-request-url": "https://pub.example.com/a",
          },
        }),
        baseDecision,
        ctx()
      );
      expect(event.header_names).toEqual(["user-agent"]);
    });

    it("is [] when the request has no headers", () => {
      const req = { url: "https://x.test/", method: "GET", headers: new Headers() } as unknown as Request;
      const event = buildAnalyticsEvent(req, baseDecision, ctx());
      expect(event.header_names).toEqual([]);
    });
  });

  describe("Capture v2 — query-string derived signals", () => {
    it("derives length and param count without storing the raw query", () => {
      const event = buildAnalyticsEvent(
        makeRequest({ url: "https://x.test/p?a=1&b=2&c=3" }),
        baseDecision,
        ctx()
      );
      expect(event.query_length).toBe("a=1&b=2&c=3".length);
      expect(event.query_param_count).toBe(3);
      expect(event.query_suspicious).toBe(false);
      // The raw query string must never appear on the event.
      expect(JSON.stringify(event)).not.toContain("a=1&b=2&c=3");
    });

    it("emits zeroes for a query-less URL", () => {
      const event = buildAnalyticsEvent(
        makeRequest({ url: "https://x.test/p" }),
        baseDecision,
        ctx()
      );
      expect(event.query_length).toBe(0);
      expect(event.query_param_count).toBe(0);
      expect(event.query_suspicious).toBe(false);
    });

    it("flags exploit markers (raw and URL-encoded)", () => {
      expect(
        buildAnalyticsEvent(makeRequest({ url: "https://x.test/?f=../../etc/passwd" }), baseDecision, ctx())
          .query_suspicious
      ).toBe(true);
      expect(
        buildAnalyticsEvent(makeRequest({ url: "https://x.test/?q=UNION%20SELECT%201" }), baseDecision, ctx())
          .query_suspicious
      ).toBe(true);
      expect(
        buildAnalyticsEvent(makeRequest({ url: "https://x.test/?x=%3Cscript%3E" }), baseDecision, ctx())
          .query_suspicious
      ).toBe(true);
    });

    it("nulls query signals when the URL is unparseable", () => {
      const req = { url: "not a url", method: "GET", headers: new Headers() } as unknown as Request;
      const event = buildAnalyticsEvent(req, baseDecision, ctx());
      expect(event.query_length).toBeNull();
      expect(event.query_param_count).toBeNull();
      expect(event.query_suspicious).toBeNull();
    });
  });

  describe("Capture v2 — CDN plumbing passthrough", () => {
    it("merges cdnSignals from context onto the event, truncating as_organization", () => {
      const event = buildAnalyticsEvent(
        makeRequest(),
        baseDecision,
        ctx({
          cdnSignals: {
            accept_encoding: "gzip, br",
            http_protocol: "HTTP/2",
            tls_version: "TLSv1.3",
            tls_cipher: "AEAD-AES128-GCM-SHA256",
            tls_client_hello_length: 1811,
            tls_client_extensions_sha1: "4cFD...",
            as_organization: "o".repeat(600),
            client_tcp_rtt: 50,
            cdn_verified_bot_category: "Search Engine Crawler",
            request_priority: "weight=256;exclusive=1",
            tls_fingerprint_ja4: null,
          },
        })
      );
      expect(event.accept_encoding).toBe("gzip, br");
      expect(event.http_protocol).toBe("HTTP/2");
      expect(event.tls_version).toBe("TLSv1.3");
      expect(event.tls_cipher).toBe("AEAD-AES128-GCM-SHA256");
      expect(event.tls_client_hello_length).toBe(1811);
      expect(event.tls_client_extensions_sha1).toBe("4cFD...");
      expect(event.as_organization).toHaveLength(512);
      expect(event.client_tcp_rtt).toBe(50);
      expect(event.cdn_verified_bot_category).toBe("Search Engine Crawler");
      expect(event.request_priority).toBe("weight=256;exclusive=1");
      expect(event.tls_fingerprint_ja4).toBeNull();
    });

    it("defaults all CDN-plumbing fields to null when cdnSignals is absent", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx());
      expect(event.accept_encoding).toBeNull();
      expect(event.http_protocol).toBeNull();
      expect(event.tls_version).toBeNull();
      expect(event.tls_cipher).toBeNull();
      expect(event.tls_client_hello_length).toBeNull();
      expect(event.tls_client_extensions_sha1).toBeNull();
      expect(event.as_organization).toBeNull();
      expect(event.client_tcp_rtt).toBeNull();
      expect(event.cdn_verified_bot_category).toBeNull();
      expect(event.request_priority).toBeNull();
      expect(event.tls_fingerprint_ja4).toBeNull();
    });
  });

  describe("Capture v2 — schema_version", () => {
    it("emits schema_version 2", () => {
      const event = buildAnalyticsEvent(makeRequest(), baseDecision, ctx());
      expect(event.schema_version).toBe(2);
    });
  });
});
