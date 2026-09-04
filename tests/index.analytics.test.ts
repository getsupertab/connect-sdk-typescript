import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SupertabConnect, HandlerAction, defaultBotDetector } from "../src/index";
import { EnforcementMode } from "../src/types";
import { AnalyticsEvent, AnalyticsTransport } from "../src/analytics/types";
import {
  HttpAnalyticsTransport,
  NoopAnalyticsTransport,
} from "../src/analytics/transport";
import { ExecutionContext } from "../src/types";
import * as license from "../src/license";

class RecordingTransport implements AnalyticsTransport {
  public events: AnalyticsEvent[] = [];
  emit(event: AnalyticsEvent, _ctx?: ExecutionContext): void {
    this.events.push(event);
  }
}

class ThrowingTransport implements AnalyticsTransport {
  emit(_event: AnalyticsEvent, _ctx?: ExecutionContext): void {
    throw new Error("transport blew up");
  }
}

// A no-token request from a bot UA so the OBSERVE branch fires.
function botRequest(): Request {
  return new Request("https://example.com/article", {
    method: "GET",
    headers: { "User-Agent": "curl/8.0" },
  });
}

describe("SupertabConnect analytics wiring", () => {
  beforeEach(() => {
    SupertabConnect.resetInstance();
  });

  afterEach(() => {
    SupertabConnect.resetInstance();
  });

  it("constructs with only { apiKey }", () => {
    expect(() => new SupertabConnect({ apiKey: "merchant-key" })).not.toThrow();
  });

  it("emits one event with no merchant_system_urn and no bot_detector_result on the observe branch", async () => {
    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      botDetector: defaultBotDetector,
      analyticsTransport: transport,
    });

    const result = await sdk.handleRequest(botRequest(), { sourceCdn: "cloudflare" });

    expect(result.action).toBe(HandlerAction.ALLOW);
    expect(transport.events).toHaveLength(1);

    const event = transport.events[0];
    expect(event).not.toHaveProperty("merchant_system_urn");
    expect(event).not.toHaveProperty("bot_detector_result");
    expect(event.final_action).toBe("observe");
    expect(event.enforcement_mode).toBe("observe");
    expect(event.has_token).toBe(false);
    expect(event.token_outcome).toBe("absent");
  });

  it("emits token_outcome 'not_validated' for a token-bearing request in DISABLED mode (no verification)", async () => {
    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.DISABLED,
      analyticsTransport: transport,
    });

    const request = new Request("https://example.com/article", {
      method: "GET",
      headers: { Authorization: "License some-token" },
    });

    const result = await sdk.handleRequest(request, { sourceCdn: "cloudflare" });

    expect(result.action).toBe(HandlerAction.ALLOW);
    expect(transport.events).toHaveLength(1);

    const event = transport.events[0];
    expect(event.has_token).toBe(true);
    expect(event.token_outcome).toBe("not_validated");
    expect(event.final_action).toBe("allow");
    expect(event.enforcement_mode).toBe("disabled");
  });

  it("forwards classification signals from context into the emitted event", async () => {
    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      botDetector: defaultBotDetector,
      analyticsTransport: transport,
    });

    await sdk.handleRequest(botRequest(), {
      sourceCdn: "fastly",
      requestCountry: "DE",
      requestAsn: 3320,
      tlsFingerprint: "ja3-abc",
    });

    const event = transport.events[0];
    expect(event.source_cdn).toBe("fastly");
    expect(event.request_country).toBe("DE");
    expect(event.request_asn).toBe(3320);
    expect(event.tls_fingerprint).toBe("ja3-abc");
  });

  it("leaves client_ip_source null when the caller supplies an address but no provenance", async () => {
    // The direct-integration case (host apps, the PHP SDK): only the caller knows whether
    // its address came from a trusted header or from REMOTE_ADDR behind a proxy. Guessing
    // would put an unearned claim in the warehouse, so an undeclared source stays NULL.
    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      botDetector: defaultBotDetector,
      analyticsTransport: transport,
    });

    await sdk.handleRequest(botRequest(), { clientIp: "203.0.113.9" });

    expect(transport.events[0].client_ip).toBe("::ffff:203.0.113.9");
    expect(transport.events[0].client_ip_source).toBeNull();
  });

  it("emits source_cdn=null when invoked without a CDN context", async () => {
    const transport = new RecordingTransport();
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      botDetector: defaultBotDetector,
      analyticsTransport: transport,
    });

    await sdk.handleRequest(botRequest());

    expect(transport.events[0].source_cdn).toBeNull();
  });

  it("FAIL-OPEN: a transport whose emit throws does not change the handler action", async () => {
    const sdk = new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      botDetector: defaultBotDetector,
      analyticsTransport: new ThrowingTransport(),
    });

    const result = await sdk.handleRequest(botRequest(), { sourceCdn: "cloudflare" });

    // The throwing transport must not affect enforcement: observe-mode bot → ALLOW pass-through.
    expect(result.action).toBe(HandlerAction.ALLOW);
  });
});

describe("deferred analytics (status capture)", () => {
  const ctx = { waitUntil: () => {} };

  function sdkWith(transport: RecordingTransport): SupertabConnect {
    return new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.OBSERVE,
      botDetector: defaultBotDetector,
      analyticsTransport: transport,
    });
  }

  beforeEach(() => SupertabConnect.resetInstance());
  afterEach(() => SupertabConnect.resetInstance());

  it("sends nothing until the response is reported", async () => {
    const transport = new RecordingTransport();

    const result = await sdkWith(transport).handleRequest(botRequest(), { ctx, deferAnalytics: true });

    expect(transport.events).toHaveLength(0);
    result.reportResponse?.(200);
    expect(transport.events).toHaveLength(1);
  });

  it("records the reported status as observed", async () => {
    const transport = new RecordingTransport();

    const result = await sdkWith(transport).handleRequest(botRequest(), { ctx, deferAnalytics: true });
    result.reportResponse?.(404);

    expect(transport.events[0].status_code).toBe(404);
    expect(transport.events[0].status_source).toBe("observed");
  });

  it("records origin_error when the caller reports no status", async () => {
    // The wrapper's finally fires with a null status when the origin fetch threw. That is a
    // fact about the request — the origin failed — not a gap in our capture, and scoring
    // must be able to tell the two apart.
    const transport = new RecordingTransport();

    const result = await sdkWith(transport).handleRequest(botRequest(), { ctx, deferAnalytics: true });
    result.reportResponse?.(null, "origin_error");

    expect(transport.events[0].status_code).toBeNull();
    expect(transport.events[0].status_source).toBe("origin_error");
  });

  it("emits eagerly as unobserved when there is no ExecutionContext to defer into", async () => {
    // Deferral is a request, not a command. Without waitUntil a deferred emit would start as
    // the response returns and could be lost to teardown, so delivery wins over the status —
    // and the event says which, instead of leaving a null nothing can read.
    const transport = new RecordingTransport();

    const result = await sdkWith(transport).handleRequest(botRequest(), { deferAnalytics: true });

    expect(transport.events).toHaveLength(1);
    expect(transport.events[0].status_code).toBeNull();
    expect(transport.events[0].status_source).toBe("unobserved");
    expect(result.reportResponse).toBeUndefined();
  });

  it("emits eagerly as unobserved when the caller never opts in", async () => {
    const transport = new RecordingTransport();

    await sdkWith(transport).handleRequest(botRequest(), { ctx });

    expect(transport.events).toHaveLength(1);
    expect(transport.events[0].status_source).toBe("unobserved");
  });

  it("sends one event when the response is reported twice", async () => {
    // A wrapper that reports in a finally *and* on an early return must not double-count.
    const transport = new RecordingTransport();

    const result = await sdkWith(transport).handleRequest(botRequest(), { ctx, deferAnalytics: true });
    result.reportResponse?.(200);
    result.reportResponse?.(500);

    expect(transport.events).toHaveLength(1);
    expect(transport.events[0].status_code).toBe(200);
  });

  it("sends nothing for a path that never emitted, even when reported", async () => {
    // The self-report status probe returns without emitting. Reporting a response for it must
    // not conjure an event that the un-deferred path would never have produced.
    const transport = new RecordingTransport();
    const probe = new Request("https://example.com/.well-known/supertab/status", {
      method: "GET",
      headers: { "User-Agent": "curl/8.0" },
    });

    const result = await sdkWith(transport).handleRequest(probe, { ctx, deferAnalytics: true });
    result.reportResponse?.(404);

    expect(transport.events).toHaveLength(0);
  });

  function enforcingSdk(transport: RecordingTransport): SupertabConnect {
    return new SupertabConnect({
      apiKey: "merchant-key",
      enforcement: EnforcementMode.ENFORCE,
      botDetector: defaultBotDetector,
      analyticsTransport: transport,
    });
  }

  it("sends the BLOCK status immediately, without waiting to be reported", async () => {
    // A blocked request already knows its own status, so there is nothing to wait for and no
    // window in which the event can be lost. The status we serve is as much "what the client
    // got" as the origin's is — final_action records why we blocked, status_code what the
    // blocked client actually saw.
    const transport = new RecordingTransport();

    const result = await enforcingSdk(transport).handleRequest(botRequest(), { ctx, deferAnalytics: true });
    if (result.action !== HandlerAction.BLOCK) throw new Error("expected a BLOCK");

    expect(transport.events).toHaveLength(1);
    expect(result.reportResponse).toBeUndefined();
    expect(transport.events[0].final_action).toBe("block");
    expect(transport.events[0].status_source).toBe("observed");
    expect(transport.events[0].status_code).toBe(result.status);
  });

  it("captures the BLOCK status even when the caller never opts into deferral", async () => {
    // The status is ours either way, so an integration that does not defer should not be
    // recording "unobserved" for a response it chose itself.
    const transport = new RecordingTransport();

    const result = await enforcingSdk(transport).handleRequest(botRequest(), { ctx });
    if (result.action !== HandlerAction.BLOCK) throw new Error("expected a BLOCK");

    expect(transport.events[0].status_source).toBe("observed");
    expect(transport.events[0].status_code).toBe(result.status);
  });

  it("still sends the event when the decision throws after emitting", async () => {
    // decide() emits before it builds its result. Holding the emit must not make a throw in
    // between lose an event that an eager emit would already have sent.
    const transport = new RecordingTransport();
    const boom = new Error("result construction failed");
    const buildSpy = vi.spyOn(license, "buildBlockResult").mockImplementation(() => {
      throw boom;
    });

    try {
      await expect(
        enforcingSdk(transport).handleRequest(botRequest(), { ctx, deferAnalytics: true })
      ).rejects.toThrow(boom);
    } finally {
      buildSpy.mockRestore();
    }

    expect(transport.events).toHaveLength(1);
    expect(transport.events[0].final_action).toBe("block");
    expect(transport.events[0].status_code).toBeNull();
    expect(transport.events[0].status_source).toBe("unobserved");
  });
});

describe("constructor warning for misrouted Fastly options", () => {
  beforeEach(() => SupertabConnect.resetInstance());
  afterEach(() => SupertabConnect.resetInstance());

  it("warns when logEndpoint is passed to the constructor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new SupertabConnect({ apiKey: "k", ...({"logEndpoint": "bot_events"} as object) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("logEndpoint"));
    warn.mockRestore();
  });

  it("warns when merchantSystemUrn is passed to the constructor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new SupertabConnect({ apiKey: "k", ...({"merchantSystemUrn": "urn:stc:ms:abc"} as object) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("merchantSystemUrn"));
    warn.mockRestore();
  });

  it("warning fires even when the singleton already exists", () => {
    new SupertabConnect({ apiKey: "k" }); // create singleton
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new SupertabConnect({ apiKey: "k", ...({"logEndpoint": "bot_events"} as object) });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mentions selectFastlyAnalyticsTransport in the warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new SupertabConnect({ apiKey: "k", ...({"logEndpoint": "bot_events"} as object) });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("selectFastlyAnalyticsTransport"));
    warn.mockRestore();
  });
});

describe("analytics transport selection (platform-agnostic constructor)", () => {
  beforeEach(() => SupertabConnect.resetInstance());
  afterEach(() => SupertabConnect.resetInstance());

  function selected(config: ConstructorParameters<typeof SupertabConnect>[0]) {
    return (new SupertabConnect(config) as unknown as { analyticsTransport: AnalyticsTransport })
      .analyticsTransport;
  }

  it("analytics disabled → Noop", () => {
    expect(selected({ apiKey: "k" })).toBeInstanceOf(NoopAnalyticsTransport);
  });

  it("analytics enabled → HTTP relay (no platform sniffing here)", () => {
    expect(selected({ apiKey: "k", analyticsEnabled: true })).toBeInstanceOf(HttpAnalyticsTransport);
  });

  it("injected analyticsTransport wins (the DI seam handlers use)", () => {
    const injected = new RecordingTransport();
    expect(selected({ apiKey: "k", analyticsEnabled: true, analyticsTransport: injected })).toBe(injected);
  });
});

describe("singleton immutability (same apiKey)", () => {
  beforeEach(() => SupertabConnect.resetInstance());
  afterEach(() => SupertabConnect.resetInstance());

  function internals(sdk: SupertabConnect) {
    return sdk as unknown as { analyticsEnabled: boolean; analyticsTransport: AnalyticsTransport; debug: boolean };
  }

  it("returns the existing instance UNCHANGED — a later construction never mutates shared config", () => {
    const first = new SupertabConnect({ apiKey: "k" });
    expect(internals(first).analyticsEnabled).toBe(false);
    expect(internals(first).analyticsTransport).toBeInstanceOf(NoopAnalyticsTransport);

    const second = new SupertabConnect({ apiKey: "k", analyticsEnabled: true, debug: true });
    expect(second).toBe(first);
    // Options from the second construction are ignored: in-flight requests holding the
    // instance must never see another caller's configuration.
    expect(internals(second).analyticsEnabled).toBe(false);
    expect(internals(second).analyticsTransport).toBeInstanceOf(NoopAnalyticsTransport);
    expect(internals(second).debug).toBe(false);
  });

  it("reset: true replaces the singleton with a freshly configured instance", () => {
    const first = new SupertabConnect({ apiKey: "k" });
    const second = new SupertabConnect({ apiKey: "k", analyticsEnabled: true }, true);
    expect(second).not.toBe(first);
    expect(internals(second).analyticsEnabled).toBe(true);
    expect(internals(second).analyticsTransport).toBeInstanceOf(HttpAnalyticsTransport);
  });

  it("still throws on a different apiKey without reset", () => {
    new SupertabConnect({ apiKey: "k" });
    expect(() => new SupertabConnect({ apiKey: "other" })).toThrow(/resetInstance/);
  });
});

describe("analytics base URL resolution", () => {
  // The dedicated ingest service host the relay targets by default. Distinct from the
  // API base URL (token acquisition / JWKS / verify), which stays on api-connect.
  const DEFAULT_INGEST = "https://ingest-connect.supertab.co";
  let originalBaseUrl: string;
  let originalAnalyticsBaseUrl: string;

  beforeEach(() => {
    SupertabConnect.resetInstance();
    // Save the static hosts so a test that mutates them can't leak into the next.
    originalBaseUrl = SupertabConnect.getBaseUrl();
    originalAnalyticsBaseUrl = SupertabConnect.getAnalyticsBaseUrl();
  });

  afterEach(() => {
    SupertabConnect.setBaseUrl(originalBaseUrl);
    SupertabConnect.setAnalyticsBaseUrl(originalAnalyticsBaseUrl);
    SupertabConnect.resetInstance();
  });

  function relayUrl(config: ConstructorParameters<typeof SupertabConnect>[0]): string {
    const transport = (new SupertabConnect(config) as unknown as {
      analyticsTransport: { url: string };
    }).analyticsTransport;
    return transport.url;
  }

  it("defaults the analytics relay to the ingest host", () => {
    expect(relayUrl({ apiKey: "k", analyticsEnabled: true })).toBe(
      `${DEFAULT_INGEST}/ingest/events`
    );
  });

  it("config.analyticsBaseUrl overrides the default host", () => {
    expect(
      relayUrl({ apiKey: "k", analyticsEnabled: true, analyticsBaseUrl: "https://ingest.example.com" })
    ).toBe("https://ingest.example.com/ingest/events");
  });

  it("setAnalyticsBaseUrl overrides the default host", () => {
    SupertabConnect.setAnalyticsBaseUrl("https://static.example.com");
    expect(relayUrl({ apiKey: "k", analyticsEnabled: true })).toBe(
      "https://static.example.com/ingest/events"
    );
  });

  it("config.analyticsBaseUrl beats setAnalyticsBaseUrl", () => {
    SupertabConnect.setAnalyticsBaseUrl("https://static.example.com");
    expect(
      relayUrl({ apiKey: "k", analyticsEnabled: true, analyticsBaseUrl: "https://perinstance.example.com" })
    ).toBe("https://perinstance.example.com/ingest/events");
  });

  it("analytics host is independent of setBaseUrl (the token/JWKS base)", () => {
    SupertabConnect.setBaseUrl("https://api.example.com");
    expect(relayUrl({ apiKey: "k", analyticsEnabled: true })).toBe(
      `${DEFAULT_INGEST}/ingest/events`
    );
  });

  it("getAnalyticsBaseUrl reflects setAnalyticsBaseUrl", () => {
    SupertabConnect.setAnalyticsBaseUrl("https://x.example.com");
    expect(SupertabConnect.getAnalyticsBaseUrl()).toBe("https://x.example.com");
  });
});
