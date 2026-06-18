import { describe, it, expect } from "vitest";
import {
  buildBotEventRow,
  toEnforcementOutcome,
  toTokenOutcome,
  BOT_EVENTS_SCHEMA_VERSION,
  type BotEventSignals,
} from "../src/bot-events";
import { EnforcementMode, LicenseTokenInvalidReason } from "../src/types";

describe("toEnforcementOutcome", () => {
  it("maps SDK enforcement modes to the warehouse vocabulary", () => {
    expect(toEnforcementOutcome(EnforcementMode.SOFT)).toBe("observe");
    expect(toEnforcementOutcome(EnforcementMode.STRICT)).toBe("enforce");
    expect(toEnforcementOutcome(EnforcementMode.DISABLED)).toBe("disabled");
  });
});

describe("toTokenOutcome", () => {
  it("maps each license-token failure reason to the warehouse vocabulary", () => {
    expect(toTokenOutcome(LicenseTokenInvalidReason.MISSING_TOKEN)).toBe("absent");
    expect(toTokenOutcome(LicenseTokenInvalidReason.EXPIRED)).toBe("expired");
    expect(toTokenOutcome(LicenseTokenInvalidReason.SIGNATURE_VERIFICATION_FAILED)).toBe("invalid_signature");
    expect(toTokenOutcome(LicenseTokenInvalidReason.INVALID_AUDIENCE)).toBe("invalid_audience");
    expect(toTokenOutcome(LicenseTokenInvalidReason.INVALID_ISSUER)).toBe("invalid_issuer");
    expect(toTokenOutcome(LicenseTokenInvalidReason.INVALID_HEADER)).toBe("malformed");
    expect(toTokenOutcome(LicenseTokenInvalidReason.INVALID_ALG)).toBe("malformed");
    expect(toTokenOutcome(LicenseTokenInvalidReason.INVALID_PAYLOAD)).toBe("malformed");
    expect(toTokenOutcome(LicenseTokenInvalidReason.SERVER_ERROR)).toBe("server_error");
  });
});

const signals: BotEventSignals = {
  has_token: false,
  token_outcome: "absent",
  final_action: "observe",
  enforcement_mode: "observe",
};

describe("buildBotEventRow", () => {
  it("produces a full bot_events_raw row from a request + signals", () => {
    const request = new Request("https://docs.example.com/articles/intro?ref=x", {
      method: "GET",
      headers: {
        "User-Agent": "GPTBot/1.0",
        Referer: "https://news.example.com",
        "Accept-Language": "en-US",
      },
    });

    const row = buildBotEventRow({
      merchantSystemUrn: "urn:stc:merchant:system:abc",
      request,
      clientIp: "203.0.113.42",
      requestCountry: "US",
      requestAsn: 13335,
      signals,
      timestamp: new Date("2026-06-18T10:30:00.123Z"),
      requestId: "req-1",
    });

    expect(row).toEqual({
      merchant_system_urn: "urn:stc:merchant:system:abc",
      timestamp: "2026-06-18T10:30:00.123Z",
      request_id: "req-1",
      schema_version: BOT_EVENTS_SCHEMA_VERSION,
      source_cdn: "fastly",
      user_agent: "GPTBot/1.0",
      client_ip: "203.0.113.42",
      path: "/articles/intro",
      method: "GET",
      referer: "https://news.example.com",
      accept_language: "en-US",
      request_country: "US",
      request_asn: 13335,
      tls_fingerprint: null,
      has_token: false,
      token_outcome: "absent",
      final_action: "observe",
      enforcement_mode: "observe",
      signature_agent: null,
      signature_input: null,
      signature: null,
    });
  });

  it("defaults missing headers to empty strings and optional fields to null", () => {
    const request = new Request("https://docs.example.com/robots.txt", { method: "HEAD" });

    const row = buildBotEventRow({
      merchantSystemUrn: "urn:stc:merchant:system:abc",
      request,
      clientIp: "::1",
      signals,
      timestamp: new Date("2026-06-18T00:00:00.000Z"),
      requestId: "req-2",
    });

    expect(row.user_agent).toBe("");
    expect(row.referer).toBe("");
    expect(row.accept_language).toBe("");
    expect(row.request_country).toBeNull();
    expect(row.request_asn).toBeNull();
    expect(row.tls_fingerprint).toBeNull();
    expect(row.path).toBe("/robots.txt");
    expect(row.method).toBe("HEAD");
  });

  it("carries the classification signals and allows overriding source_cdn", () => {
    const request = new Request("https://docs.example.com/", { method: "GET" });

    const row = buildBotEventRow({
      merchantSystemUrn: "urn:stc:merchant:system:abc",
      request,
      clientIp: "203.0.113.1",
      sourceCdn: "fastly_compute",
      signals: {
        has_token: true,
        token_outcome: "valid",
        final_action: "allow",
        enforcement_mode: "enforce",
      },
      timestamp: new Date("2026-06-18T10:30:00.000Z"),
      requestId: "req-3",
    });

    expect(row.source_cdn).toBe("fastly_compute");
    expect(row.has_token).toBe(true);
    expect(row.token_outcome).toBe("valid");
    expect(row.final_action).toBe("allow");
    expect(row.enforcement_mode).toBe("enforce");
  });
});
