import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpAnalyticsTransport,
  NoopAnalyticsTransport,
  DEFAULT_ANALYTICS_ENDPOINT,
} from "../../src/analytics/transport";
import { AnalyticsEvent } from "../../src/analytics/types";

const fixtureEvent: AnalyticsEvent = {
  merchant_id: "merchant-abc",
  timestamp: "2026-04-29T12:00:00.000Z",
  request_id: "req-1",
  schema_version: 1,
  source_cdn: "cloudflare",
  user_agent: "ua",
  client_ip: "::ffff:1.2.3.4",
  path: "/p",
  method: "GET",
  referer: "",
  accept_language: "en",
  has_token: false,
  token_outcome: "absent",
  bot_detector_result: "human",
  final_action: "allow",
  enforcement_mode: "observe",
};

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("HttpAnalyticsTransport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs NDJSON body with bearer token to the configured URL", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 202 }));
    const transport = new HttpAnalyticsTransport({
      url: "https://example.test/v0/events?name=bot_events_raw",
      token: "secret-token",
    });

    transport.emit(fixtureEvent);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/v0/events?name=bot_events_raw");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer secret-token");
    expect(options.headers["Content-Type"]).toBe("application/x-ndjson");
    expect(options.body).toBe(JSON.stringify(fixtureEvent) + "\n");
  });

  it("invokes ctx.waitUntil when an ExecutionContext is provided", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 202 }));
    const waitUntil = vi.fn();
    const transport = new HttpAnalyticsTransport({
      url: "https://example.test/v0/events",
      token: "t",
    });

    transport.emit(fixtureEvent, { waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("does not throw when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const transport = new HttpAnalyticsTransport({
      url: "https://example.test/v0/events",
      token: "t",
    });

    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    await flush();
  });

  it("does not throw and does not await on non-2xx responses", async () => {
    fetchMock.mockResolvedValue(new Response("err", { status: 500 }));
    const transport = new HttpAnalyticsTransport({
      url: "https://example.test/v0/events",
      token: "t",
      debug: false,
    });

    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    await flush();
  });

  it("DEFAULT_ANALYTICS_ENDPOINT points at europe-west2", () => {
    expect(DEFAULT_ANALYTICS_ENDPOINT).toContain("europe-west2");
    expect(DEFAULT_ANALYTICS_ENDPOINT).toContain("name=bot_events_raw");
  });
});

describe("NoopAnalyticsTransport", () => {
  it("emit is a no-op and never throws", () => {
    const transport = new NoopAnalyticsTransport();
    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    expect(() => transport.emit(fixtureEvent, { waitUntil: () => {} })).not.toThrow();
  });
});
