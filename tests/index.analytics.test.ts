import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SupertabConnect, HandlerAction, defaultBotDetector } from "../src/index";
import { EnforcementMode } from "../src/types";
import { AnalyticsEvent, AnalyticsTransport } from "../src/analytics/types";
import {
  HttpAnalyticsTransport,
  NoopAnalyticsTransport,
} from "../src/analytics/transport";
import { ExecutionContext } from "../src/types";

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
