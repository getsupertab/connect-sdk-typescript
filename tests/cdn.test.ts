import { describe, it, expect } from "vitest";
import { parseAsn, extractCloudflareCdnSignals, handleFastlyRequest } from "../src/cdn";
import { HandlerAction } from "../src/types";

// Records the context handed to handleRequest and short-circuits with a RESPOND
// so no origin fetch happens during the test.
function recordingHandler() {
  const calls: any[] = [];
  return {
    calls,
    handleRequest: async (_req: Request, context?: any) => {
      calls.push(context);
      return { action: HandlerAction.RESPOND, status: 200, body: "ok", headers: {} };
    },
  };
}

describe("extractCloudflareCdnSignals", () => {
  it("maps free-plan request.cf fields, parsing tlsClientHelloLength to an int", () => {
    const signals = extractCloudflareCdnSignals({
      clientAcceptEncoding: "gzip, br",
      httpProtocol: "HTTP/2",
      tlsVersion: "TLSv1.3",
      tlsCipher: "AEAD-AES128-GCM-SHA256",
      // Arrives as a string from Cloudflare.
      tlsClientHelloLength: "1811",
      tlsClientExtensionsSha1: "4cFD...",
      asOrganization: "TE Data",
      clientTcpRtt: 50,
      verifiedBotCategory: "Search Engine Crawler",
      requestPriority: "weight=256;exclusive=1",
    });

    expect(signals.accept_encoding).toBe("gzip, br");
    expect(signals.http_protocol).toBe("HTTP/2");
    expect(signals.tls_version).toBe("TLSv1.3");
    expect(signals.tls_cipher).toBe("AEAD-AES128-GCM-SHA256");
    expect(signals.tls_client_hello_length).toBe(1811);
    expect(signals.tls_client_extensions_sha1).toBe("4cFD...");
    expect(signals.as_organization).toBe("TE Data");
    expect(signals.client_tcp_rtt).toBe(50);
    expect(signals.cdn_verified_bot_category).toBe("Search Engine Crawler");
    expect(signals.request_priority).toBe("weight=256;exclusive=1");
  });

  it("nulls missing and empty-string fields, and JA4 on the free plan", () => {
    const signals = extractCloudflareCdnSignals({ verifiedBotCategory: "" });
    expect(signals.accept_encoding).toBeNull();
    expect(signals.http_protocol).toBeNull();
    expect(signals.tls_client_hello_length).toBeNull();
    expect(signals.client_tcp_rtt).toBeNull();
    // verifiedBotCategory is "" for non-bots → null, not "".
    expect(signals.cdn_verified_bot_category).toBeNull();
    // botManagement is absent on the free plan → JA4 null.
    expect(signals.tls_fingerprint_ja4).toBeNull();
  });

  it("reads JA4 from botManagement when present (Enterprise)", () => {
    const signals = extractCloudflareCdnSignals({ botManagement: { ja4: "t13d1516h2_..." } });
    expect(signals.tls_fingerprint_ja4).toBe("t13d1516h2_...");
  });
});

describe("parseAsn", () => {
  it("parses a plain numeric ASN", () => {
    expect(parseAsn("13335")).toBe(13335);
  });

  it("parses an AS-prefixed ASN", () => {
    expect(parseAsn("AS13335")).toBe(13335);
  });

  it("returns null for zero", () => {
    expect(parseAsn("0")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseAsn("")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseAsn("abc")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseAsn(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseAsn(undefined)).toBeNull();
  });
});

describe("handleFastlyRequest client signals", () => {
  const req = () =>
    new Request("https://example.com/article", {
      headers: {
        // VCL-only header fallbacks — should lose to Compute event values.
        "fastly-client-ip": "10.0.0.1",
        "fastly-client-country-code": "US",
        "fastly-client-asn": "AS7018",
        "fastly-client-ja3": "ja3-from-header",
      },
    });

  it("prefers event.client signals passed via clientContext over the VCL headers", async () => {
    const handler = recordingHandler();
    await handleFastlyRequest(handler, req(), "origin", undefined, {
      clientIp: "203.0.113.9",
      requestCountry: "DE",
      requestAsn: 3320,
      tlsFingerprint: "ja3-from-event",
    });

    const ctx = handler.calls[0];
    expect(ctx.clientIp).toBe("203.0.113.9");
    expect(ctx.requestCountry).toBe("DE");
    expect(ctx.requestAsn).toBe(3320);
    expect(ctx.tlsFingerprint).toBe("ja3-from-event");
  });

  it("falls back to the fastly-client-ja3 header when clientContext has no fingerprint", async () => {
    const handler = recordingHandler();
    await handleFastlyRequest(handler, req(), "origin", undefined, {
      clientIp: "203.0.113.9",
      requestCountry: "DE",
      requestAsn: 3320,
      // tlsFingerprint omitted — VCL header should win.
    });

    expect(handler.calls[0].tlsFingerprint).toBe("ja3-from-header");
  });
});
