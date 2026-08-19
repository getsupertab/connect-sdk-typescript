import { describe, it, expect, vi } from "vitest";
import {
  parseAsn,
  extractCloudflareCdnSignals,
  extractCloudfrontCdnSignals,
  handleFastlyRequest,
  handleCloudfrontRequest,
} from "../src/cdn";
import { HandlerAction, CloudFrontRequestEvent } from "../src/types";

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

describe("extractCloudfrontCdnSignals", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("maps viewer headers, splitting cloudfront-viewer-tls into version and cipher", () => {
    const signals = extractCloudfrontCdnSignals(
      h({
        "accept-encoding": "gzip, br",
        "cloudfront-viewer-http-version": "2.0",
        "cloudfront-viewer-tls": "TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake",
        "cloudfront-viewer-as-name": "AMAZON-02",
        "cloudfront-viewer-ja4-fingerprint": "t13d1516h2_...",
      })
    );

    expect(signals.accept_encoding).toBe("gzip, br");
    expect(signals.http_protocol).toBe("2.0");
    expect(signals.tls_version).toBe("TLSv1.3");
    expect(signals.tls_cipher).toBe("TLS_AES_128_GCM_SHA256");
    expect(signals.as_organization).toBe("AMAZON-02");
    expect(signals.tls_fingerprint_ja4).toBe("t13d1516h2_...");
  });

  it("nulls signals CloudFront does not expose, and TLS parts when the header is absent", () => {
    const signals = extractCloudfrontCdnSignals(h({}));
    expect(signals.tls_version).toBeNull();
    expect(signals.tls_cipher).toBeNull();
    expect(signals.accept_encoding).toBeNull();
    expect(signals.tls_client_hello_length).toBeNull();
    expect(signals.client_tcp_rtt).toBeNull();
    expect(signals.cdn_verified_bot_category).toBeNull();
    expect(signals.request_priority).toBeNull();
    expect(signals.tls_fingerprint_ja4).toBeNull();
  });
});

describe("handleCloudfrontRequest", () => {
  const event = (): CloudFrontRequestEvent => ({
    Records: [
      {
        cf: {
          config: { requestId: "req-1" },
          request: {
            uri: "/article",
            method: "GET",
            querystring: "",
            clientIp: "203.0.113.9",
            headers: {
              host: [{ key: "Host", value: "example.com" }],
              "cloudfront-viewer-tls": [{ value: "TLSv1.3:TLS_AES_128_GCM_SHA256:fullHandshake" }],
            },
          },
        },
      },
    ],
  });

  it("passes cloudfront source and cdnSignals into handleRequest", async () => {
    const calls: any[] = [];
    const handler = {
      handleRequest: async (_req: Request, context?: any) => {
        calls.push(context);
        return { action: HandlerAction.RESPOND, status: 200, body: "ok", headers: {} };
      },
    };

    await handleCloudfrontRequest(handler, event());

    expect(calls[0].sourceCdn).toBe("cloudfront");
    expect(calls[0].cdnSignals.tls_version).toBe("TLSv1.3");
    expect(calls[0].cdnSignals.tls_cipher).toBe("TLS_AES_128_GCM_SHA256");
  });

  // Handler that emits an analytics event via ctx.waitUntil, like the real transport path.
  function emittingHandler(emitPromise: Promise<void>) {
    const calls: any[] = [];
    return {
      calls,
      handleRequest: async (_req: Request, context?: any) => {
        calls.push(context);
        context?.ctx?.waitUntil(emitPromise);
        return { action: HandlerAction.RESPOND, status: 200, body: "ok", headers: {} };
      },
    };
  }

  it("hands handleRequest a ctx whose waitUntil collects pending work", async () => {
    const handler = emittingHandler(Promise.resolve());
    await handleCloudfrontRequest(handler, event());
    expect(typeof handler.calls[0].ctx.waitUntil).toBe("function");
  });

  it("awaits the emit before returning when it settles quickly", async () => {
    let settled = false;
    const emit = Promise.resolve().then(() => { settled = true; });
    const handler = emittingHandler(emit);

    await handleCloudfrontRequest(handler, event());
    expect(settled).toBe(true);
  });

  it("awaits a slow emit fully when no timeout is given", async () => {
    let settled = false;
    const emit = new Promise<void>((resolve) =>
      setTimeout(() => { settled = true; resolve(); }, 150)
    );
    const handler = emittingHandler(emit);

    await handleCloudfrontRequest(handler, event());
    expect(settled).toBe(true);
  });

  it("drains all pending promises (analytics emit + legacy event recording)", async () => {
    let first = false;
    let second = false;
    const handler = {
      handleRequest: async (_req: Request, context?: any) => {
        context?.ctx?.waitUntil(new Promise<void>((r) => setTimeout(() => { first = true; r(); }, 30)));
        context?.ctx?.waitUntil(new Promise<void>((r) => setTimeout(() => { second = true; r(); }, 60)));
        return { action: HandlerAction.RESPOND, status: 200, body: "ok", headers: {} };
      },
    };

    await handleCloudfrontRequest(handler, event());
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("stays silent about the drain unless debug is on", async () => {
    const handler = emittingHandler(Promise.resolve());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleCloudfrontRequest(handler, event());
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("logs the drain with the cap when debug is on", async () => {
    const handler = emittingHandler(Promise.resolve());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleCloudfrontRequest(handler, event(), 3000, true);
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain("cloudfront drain: 1 pending");
      expect(line).toContain("(cap 3000ms)");
    } finally {
      log.mockRestore();
    }
  });

  it("returns within the timeout even if the emit never settles", async () => {
    const handler = emittingHandler(new Promise<void>(() => {})); // never resolves
    const result = await handleCloudfrontRequest(handler, event(), 20);

    // The RESPOND decision still produces a CloudFront response result.
    expect((result as any).status).toBe("200");
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

  it("forwards the ExecutionContext (FetchEvent.waitUntil bridge) into the handler context", async () => {
    const handler = recordingHandler();
    const ctx = { waitUntil: () => {} };
    await handleFastlyRequest(handler, req(), "origin", undefined, {}, ctx);

    expect(handler.calls[0].ctx).toBe(ctx);
  });
});
