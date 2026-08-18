import { describe, it, expect, vi } from "vitest";
import {
  parseAsn,
  extractCloudflareCdnSignals,
  handleFastlyRequest,
  handleCloudflareRequest,
  handleCloudfrontRequest,
} from "../src/cdn";
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

describe("handleCloudflareRequest client signals", () => {
  const ctx = { waitUntil: () => {} };

  it("reports cdn_declared when cf-connecting-ip is present", async () => {
    const handler = recordingHandler();
    const request = new Request("https://example.com/article", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });

    await handleCloudflareRequest(handler, request, ctx);

    expect(handler.calls[0].clientIp).toBe("203.0.113.9");
    expect(handler.calls[0].clientIpSource).toBe("cdn_declared");
  });

  it("reports absent when cf-connecting-ip is missing", async () => {
    const handler = recordingHandler();

    await handleCloudflareRequest(handler, new Request("https://example.com/article"), ctx);

    expect(handler.calls[0].clientIp).toBeUndefined();
    expect(handler.calls[0].clientIpSource).toBe("absent");
  });

  it("reports absent for a present-but-empty cf-connecting-ip", async () => {
    // The header exists but carries no address, so clientIp normalizes to the "::" sentinel.
    // Testing presence rather than value would label that sentinel `cdn_declared`.
    const handler = recordingHandler();
    const request = new Request("https://example.com/article", {
      headers: { "cf-connecting-ip": "" },
    });

    await handleCloudflareRequest(handler, request, ctx);

    expect(handler.calls[0].clientIp).toBeUndefined();
    expect(handler.calls[0].clientIpSource).toBe("absent");
  });
});

describe("wrapper status reporting", () => {
  const ctx = { waitUntil: () => {} };

  // Records what the wrapper reported, standing in for the deferred emit.
  function reportingHandler(action: HandlerAction, status = 402) {
    const reported: Array<[number | null, string | undefined]> = [];
    return {
      reported,
      handleRequest: async () => ({
        action,
        status,
        body: "blocked",
        headers: {},
        reportResponse: (s: number | null, src?: string) => reported.push([s, src]),
      }),
    };
  }

  it("reports the origin's status on the Cloudflare ALLOW path", async () => {
    const handler = reportingHandler(HandlerAction.ALLOW);
    // 204 must carry no body — a real origin response the wrapper has to pass through intact.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    try {
      await handleCloudflareRequest(handler as any, new Request("https://example.com/a"), ctx);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(handler.reported).toEqual([[204, undefined]]);
  });

  it("reports origin_error, and still reports at all, when the origin fetch throws", async () => {
    // Losing the status is acceptable; losing the whole event is not. The finally is what
    // guarantees the second part, and "origin_error" is a signal in its own right.
    const handler = reportingHandler(HandlerAction.ALLOW);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("origin down"));

    try {
      await expect(
        handleCloudflareRequest(handler as any, new Request("https://example.com/a"), ctx)
      ).rejects.toThrow("origin down");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(handler.reported).toEqual([[null, "origin_error"]]);
  });

  it("reports nothing from the wrapper on the BLOCK path", async () => {
    // A blocked request already knows its own status, so handleRequest sends the event itself
    // and attaches no reporter. The wrapper must not report a null over the top of it.
    const handler = reportingHandler(HandlerAction.BLOCK, 401);

    const response = await handleCloudflareRequest(handler as any, new Request("https://example.com/a"), ctx);

    expect(response.status).toBe(401);
    expect(handler.reported).toEqual([]);
  });

  it("reports the fail-open retry's status rather than origin_error", async () => {
    // cloudflareHandleRequests retries a failed origin fetch, so reporting from a boundary
    // the retry sits outside of would record "origin_error" for a request the client saw
    // served. origin_error means no response reached the client at all.
    const handler = reportingHandler(HandlerAction.ALLOW);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("origin down"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    let response: Response;
    try {
      response = await handleCloudflareRequest(handler as any, new Request("https://example.com/a"), ctx);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(handler.reported).toEqual([[200, undefined]]);
  });

  it("reports the origin's status on the Fastly ALLOW path", async () => {
    const handler = reportingHandler(HandlerAction.ALLOW);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 301 }));

    try {
      await handleFastlyRequest(handler as any, new Request("https://example.com/a"), "origin");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(handler.reported).toEqual([[301, undefined]]);
  });

  it("reports the fail-open retry's status on the Fastly ALLOW path", async () => {
    const handler = reportingHandler(HandlerAction.ALLOW);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("backend unreachable"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    let response: Response;
    try {
      response = await handleFastlyRequest(handler as any, new Request("https://example.com/a"), "origin");
    } finally {
      fetchSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(handler.reported).toEqual([[200, undefined]]);
  });
});

describe("handleCloudfrontRequest client signals", () => {
  // Lambda@Edge hands the viewer address to the function as an event field, not a header.
  const cfEvent = (clientIp?: string) => ({
    Records: [
      {
        cf: {
          config: { requestId: "req-1" },
          request: {
            clientIp,
            method: "GET",
            uri: "/article",
            querystring: "",
            headers: { host: [{ key: "Host", value: "example.com" }] },
          },
        },
      },
    ],
  });

  it("reports cdn_declared when CloudFront supplies the viewer address", async () => {
    const handler = recordingHandler();

    await handleCloudfrontRequest(handler, cfEvent("203.0.113.9") as any);

    expect(handler.calls[0].clientIp).toBe("203.0.113.9");
    expect(handler.calls[0].clientIpSource).toBe("cdn_declared");
  });

  it("reports absent when the event carries no client address", async () => {
    const handler = recordingHandler();

    await handleCloudfrontRequest(handler, cfEvent(undefined) as any);

    expect(handler.calls[0].clientIp).toBeUndefined();
    expect(handler.calls[0].clientIpSource).toBe("absent");
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

  it("carries the resolver's clientIpSource through unchanged", async () => {
    const handler = recordingHandler();
    await handleFastlyRequest(handler, req(), "origin", undefined, {
      clientIp: "203.0.113.9",
      clientIpSource: "connection",
    });

    expect(handler.calls[0].clientIpSource).toBe("connection");
  });

  it("reports cdn_declared when only the VCL fastly-client-ip header is available", async () => {
    const handler = recordingHandler();
    await handleFastlyRequest(handler, req(), "origin", undefined, {});

    expect(handler.calls[0].clientIp).toBe("10.0.0.1");
    expect(handler.calls[0].clientIpSource).toBe("cdn_declared");
  });

  it("never labels a caller-supplied address with the VCL header's provenance", async () => {
    // req() carries fastly-client-ip: 10.0.0.1, but the address in play came from the
    // caller. Deriving the source separately would stamp `cdn_declared` on an address
    // Fastly never vouched for — the claim must stay undeclared instead.
    const handler = recordingHandler();
    await handleFastlyRequest(handler, req(), "origin", undefined, {
      clientIp: "203.0.113.9",
    });

    expect(handler.calls[0].clientIp).toBe("203.0.113.9");
    expect(handler.calls[0].clientIpSource).toBeUndefined();
  });

  it("reports absent when neither the resolver nor the VCL header supplies an address", async () => {
    const handler = recordingHandler();
    const bare = new Request("https://example.com/article");
    await handleFastlyRequest(handler, bare, "origin", undefined, {});

    expect(handler.calls[0].clientIp).toBeUndefined();
    expect(handler.calls[0].clientIpSource).toBe("absent");
  });
});
