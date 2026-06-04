import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpAnalyticsTransport,
  NoopAnalyticsTransport,
  ANALYTICS_EVENTS_PATH,
} from "../../src/analytics/transport";
import { AnalyticsEvent } from "../../src/analytics/types";

const fixtureEvent: AnalyticsEvent = {
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
  request_country: "US",
  request_asn: 13335,
  tls_fingerprint: "ja3hash",
  has_token: false,
  token_outcome: "absent",
  final_action: "allow",
  enforcement_mode: "observe",
  signature_agent: null,
  signature_input: null,
  signature: null,
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

  it("POSTs a JSON body with bearer apiKey to the relay URL", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 202 }));
    const transport = new HttpAnalyticsTransport({
      url: "https://relay.test/ingest/events",
      apiKey: "merchant-api-key",
    });

    transport.emit(fixtureEvent);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://relay.test/ingest/events");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer merchant-api-key");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.body).toBe(JSON.stringify(fixtureEvent));
    // No trailing newline (relay expects a single JSON object, not NDJSON).
    expect(options.body.endsWith("\n")).toBe(false);
  });

  it("invokes ctx.waitUntil when an ExecutionContext is provided", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 202 }));
    const waitUntil = vi.fn();
    const transport = new HttpAnalyticsTransport({
      url: "https://relay.test/ingest/events",
      apiKey: "t",
    });

    transport.emit(fixtureEvent, { waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("does not throw when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const transport = new HttpAnalyticsTransport({
      url: "https://relay.test/ingest/events",
      apiKey: "t",
    });

    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    await flush();
  });

  it("does not throw and does not await on non-2xx responses", async () => {
    fetchMock.mockResolvedValue(new Response("err", { status: 500 }));
    const transport = new HttpAnalyticsTransport({
      url: "https://relay.test/ingest/events",
      apiKey: "t",
      debug: false,
    });

    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    await flush();
  });

  it("adds the Fastly backend to fetch options when running in Fastly", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fastly", {});
    try {
      const transport = new HttpAnalyticsTransport({
        url: "https://relay.test/ingest/events",
        apiKey: "t",
      });

      transport.emit(fixtureEvent);
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, options] = fetchMock.mock.calls[0];
      expect(options.backend).toBe("stc-backend");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ANALYTICS_EVENTS_PATH targets the relay events route", () => {
    expect(ANALYTICS_EVENTS_PATH).toBe("/ingest/events");
  });
});

describe("NoopAnalyticsTransport", () => {
  it("emit is a no-op and never throws", () => {
    const transport = new NoopAnalyticsTransport();
    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    expect(() => transport.emit(fixtureEvent, { waitUntil: () => {} })).not.toThrow();
  });
});
