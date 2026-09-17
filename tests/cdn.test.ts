import { describe, it, expect, vi } from "vitest";
import {
  parseAsn,
  extractCloudflareCdnSignals,
  extractCloudfrontCdnSignals,
  handleFastlyRequest,
  handleCloudflareRequest,
  handleCloudfrontRequest,
  DEFAULT_BACKGROUND_WORK_TIMEOUT_MS,
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

  it("logs settled background work with the budget when debug is on", async () => {
    const handler = emittingHandler(Promise.resolve());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleCloudfrontRequest(handler, event(), 3000, true);
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain("background work: 1 calls settled");
      expect(line).toContain("(budget 3000ms)");
    } finally {
      log.mockRestore();
    }
  });

  it("returns at the deadline even if a signal-ignoring emit never settles, and logs timed_out", async () => {
    const handler = emittingHandler(new Promise<void>(() => {})); // never resolves, ignores the signal
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await handleCloudfrontRequest(handler, event(), 20, true);

      // The RESPOND decision still produces a CloudFront response result.
      expect((result as any).status).toBe("200");
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain("timed out");
      expect(line).toContain("in-flight calls aborted");
      expect(line).not.toContain("settled");
    } finally {
      log.mockRestore();
    }
  });

  it("exposes an AbortSignal on ctx unless the budget is explicitly Infinity", async () => {
    const withBudget = emittingHandler(Promise.resolve());
    await handleCloudfrontRequest(withBudget, event(), 1000);
    expect(withBudget.calls[0].ctx.signal).toBeInstanceOf(AbortSignal);

    // Omitting the budget takes the default, which is still a budget.
    const defaulted = emittingHandler(Promise.resolve());
    await handleCloudfrontRequest(defaulted, event());
    expect(defaulted.calls[0].ctx.signal).toBeInstanceOf(AbortSignal);

    const unbounded = emittingHandler(Promise.resolve());
    await handleCloudfrontRequest(unbounded, event(), Infinity);
    expect(unbounded.calls[0].ctx.signal).toBeUndefined();
  });

  it("applies the default budget when none is given", async () => {
    const handler = emittingHandler(Promise.resolve());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleCloudfrontRequest(handler, event(), undefined, true);
      expect(log.mock.calls[0][0]).toContain(`(budget ${DEFAULT_BACKGROUND_WORK_TIMEOUT_MS}ms)`);
      expect(DEFAULT_BACKGROUND_WORK_TIMEOUT_MS).toBe(2000);
    } finally {
      log.mockRestore();
    }
  });

  it("awaits background work to completion when the budget is Infinity", async () => {
    let settled = false;
    const emit = new Promise<void>((resolve) =>
      setTimeout(() => { settled = true; resolve(); }, 50)
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleCloudfrontRequest(emittingHandler(emit), event(), Infinity, true);
      expect(settled).toBe(true);
      expect(log.mock.calls[0][0]).toContain("(unbounded)");
    } finally {
      log.mockRestore();
    }
  });

  it("aborts in-flight background work at the deadline", async () => {
    let aborted = false;
    const handler = {
      handleRequest: async (_req: Request, context?: any) => {
        const signal: AbortSignal = context.ctx.signal;
        // Settles only on abort, like a fetch honoring the signal.
        context.ctx.waitUntil(
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => { aborted = true; resolve(); });
          })
        );
        return { action: HandlerAction.RESPOND, status: 200, body: "ok", headers: {} };
      },
    };

    const result = await handleCloudfrontRequest(handler, event(), 20);
    expect(aborted).toBe(true);
    expect((result as any).status).toBe("200");
  });

  it("falls back to the default budget on an invalid value, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const invalid of [0, -1, NaN, -Infinity]) {
        let settled = false;
        const emit = new Promise<void>((resolve) =>
          setTimeout(() => { settled = true; resolve(); }, 50)
        );
        const handler = emittingHandler(emit);
        log.mockClear();

        await handleCloudfrontRequest(handler, event(), invalid, true);
        // 50ms of work under a 2s fallback budget: it still runs to completion, but the
        // deadline is armed rather than absent.
        expect(settled).toBe(true);
        expect(handler.calls[0].ctx.signal).toBeInstanceOf(AbortSignal);
        expect(log.mock.calls[0][0]).toContain(`(budget ${DEFAULT_BACKGROUND_WORK_TIMEOUT_MS}ms)`);
      }
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls[0][0]).toContain("invalid backgroundWorkTimeoutMs");
      expect(warn.mock.calls[0][0]).toContain("2000ms default");
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
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

// Records the Request the handler was given, which is what the URL reconstruction produces.
// Kept separate from recordingHandler() so the existing context assertions stay untouched.
function urlRecordingHandler(action = HandlerAction.RESPOND) {
  const requests: Request[] = [];
  return {
    requests,
    handleRequest: async (request: Request) => {
      requests.push(request);
      return action === HandlerAction.ALLOW
        ? { action, headers: {} }
        : { action: HandlerAction.RESPOND, status: 200, body: "ok", headers: {} };
    },
  };
}

// A VCL → Compute chain: the request Compute sees is addressed to the Compute service itself,
// because the backend's `override_host` replaced Host after VCL ran.
const CHAIN_URL = "https://svc.edgecompute.app/article?a=1";
function chainRequest(headers: Record<string, string> = {}) {
  return new Request(CHAIN_URL, { headers });
}

describe("handleFastlyRequest URL reconstruction", () => {
  it("hands the handler the viewer authority, not the compute host", async () => {
    const handler = urlRecordingHandler();
    await handleFastlyRequest(
      handler as any,
      chainRequest({ "x-supertab-original-authority": "www.example.com" }),
      "origin"
    );

    expect(handler.requests[0].url).toBe("https://www.example.com/article?a=1");
  });

  it("uses the configured header name passed through the options argument", async () => {
    const handler = urlRecordingHandler();
    await handleFastlyRequest(
      handler as any,
      chainRequest({ "x-supertab-viewer-host": "www.example.com" }),
      "origin",
      undefined,
      undefined,
      undefined,
      { originalAuthorityHeader: "x-supertab-viewer-host" }
    );

    expect(handler.requests[0].url).toBe("https://www.example.com/article?a=1");
  });

  it("still honours the legacy x-original-request-url header", async () => {
    const handler = urlRecordingHandler();
    await handleFastlyRequest(
      handler as any,
      chainRequest({ "x-original-request-url": "https://www.example.com/z?q=2" }),
      "origin"
    );

    expect(handler.requests[0].url).toBe("https://www.example.com/z?q=2");
  });

  it("leaves the inbound Host header on the handler request untouched", async () => {
    // Host is a forbidden header, so the SDK deliberately does not rewrite it to agree with
    // the reconstructed URL. Analytics reads the URL instead.
    const handler = urlRecordingHandler();
    await handleFastlyRequest(
      handler as any,
      chainRequest({ host: "svc.edgecompute.app", "x-supertab-original-authority": "www.example.com" }),
      "origin"
    );

    expect(handler.requests[0].headers.get("host")).toBe("svc.edgecompute.app");
    expect(new URL(handler.requests[0].url).host).toBe("www.example.com");
  });

  it("does not fail open when x-original-request-url is malformed", async () => {
    // This used to throw out of `new URL(originalUrl)` and skip enforcement entirely.
    const handler = urlRecordingHandler();
    await handleFastlyRequest(
      handler as any,
      chainRequest({ "x-original-request-url": "not a url" }),
      "origin"
    );

    expect(handler.requests[0].url).toBe(CHAIN_URL);
  });

  it("resolves license.xml from the compute-observed path when an authority header is present", async () => {
    const handler = urlRecordingHandler();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<xml/>", { status: 200 }));

    try {
      await handleFastlyRequest(
        handler as any,
        new Request("https://svc.edgecompute.app/license.xml", {
          headers: { "x-supertab-original-authority": "www.example.com" },
        }),
        "origin",
        { baseUrl: "https://api.example", merchantSystemUrn: "urn:stc:merchant:system:1" }
      );
    } finally {
      fetchSpy.mockRestore();
    }

    // Served from the edge, so the handler is never consulted.
    expect(handler.requests).toHaveLength(0);
  });

  it("forwards the original request to the origin backend, not the reconstructed one", async () => {
    const handler = urlRecordingHandler(HandlerAction.ALLOW);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));

    let forwarded: Request;
    try {
      await handleFastlyRequest(
        handler as any,
        chainRequest({ "x-supertab-original-authority": "www.example.com" }),
        "origin"
      );
      // Read before restoring — mockRestore() clears the recorded calls.
      forwarded = fetchSpy.mock.calls[0][0] as Request;
    } finally {
      fetchSpy.mockRestore();
    }

    expect(forwarded.url).toBe(CHAIN_URL);
  });
});
