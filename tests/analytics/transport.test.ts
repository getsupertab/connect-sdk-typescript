import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HttpAnalyticsTransport,
  NoopAnalyticsTransport,
  FastlyLogTransport,
  DEFAULT_FASTLY_LOG_ENDPOINT,
  ANALYTICS_EVENTS_PATH,
} from "../../src/analytics/transport";
import { AnalyticsEvent } from "../../src/analytics/types";

// Mock the Fastly Compute built-in logging module (it only exists in the Compute runtime).
const { fastlyLogSpy } = vi.hoisted(() => ({ fastlyLogSpy: vi.fn() }));
vi.mock("fastly:logger", () => ({
  Logger: class {
    constructor(public readonly endpoint: string) {}
    log(message: string): void {
      fastlyLogSpy(this.endpoint, message);
    }
  },
}));

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

describe("FastlyLogTransport", () => {
  beforeEach(() => {
    fastlyLogSpy.mockReset();
  });

  // emit() does the logging inside an async IIFE (it awaits the dynamic fastly:logger import),
  // so await the exact emission promise via waitUntil rather than racing a timer.
  function emitAndAwait(transport: FastlyLogTransport): Promise<void> {
    const pending: Promise<void>[] = [];
    transport.emit(fixtureEvent, { waitUntil: (p) => pending.push(p) });
    return Promise.all(pending).then(() => undefined);
  }

  it("logs one JSON line stamped with merchant_system_urn to the named endpoint", async () => {
    const transport = new FastlyLogTransport({
      endpoint: "bot_events",
      merchantSystemUrn: "urn:stc:merchant:system:abc",
    });

    await emitAndAwait(transport);

    expect(fastlyLogSpy).toHaveBeenCalledTimes(1);
    const [endpoint, line] = fastlyLogSpy.mock.calls[0];
    expect(endpoint).toBe("bot_events");

    const parsed = JSON.parse(line);
    expect(parsed.merchant_system_urn).toBe("urn:stc:merchant:system:abc");
    expect(parsed.request_id).toBe(fixtureEvent.request_id);
    expect(parsed.final_action).toBe(fixtureEvent.final_action);
    // One JSON object per line — no trailing newline (Fastly batches lines into NDJSON).
    expect(line.endsWith("\n")).toBe(false);
  });

  it("defaults to the bot_events endpoint when none is given", async () => {
    const transport = new FastlyLogTransport({ merchantSystemUrn: "urn:stc:merchant:system:abc" });

    await emitAndAwait(transport);

    expect(fastlyLogSpy.mock.calls[0][0]).toBe(DEFAULT_FASTLY_LOG_ENDPOINT);
  });

  it("invokes ctx.waitUntil when an ExecutionContext is provided", () => {
    const waitUntil = vi.fn();
    const transport = new FastlyLogTransport({ merchantSystemUrn: "urn:stc:merchant:system:abc" });

    transport.emit(fixtureEvent, { waitUntil });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("does not throw when logging fails", async () => {
    fastlyLogSpy.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    const transport = new FastlyLogTransport({ merchantSystemUrn: "urn:stc:merchant:system:abc" });

    expect(() => transport.emit(fixtureEvent)).not.toThrow();
    await flush();
  });
});
