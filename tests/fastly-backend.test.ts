import { describe, it, expect, vi, afterEach } from "vitest";
import {
  connectBackend,
  getConnectBackend,
  setConnectBackend,
  withFastlyBackend,
} from "../src/fastly-backend";
import { hostRSLicenseXML } from "../src/license";
import { recordEvent } from "../src/events";
import { fetchPlatformJwks, clearJwksCache } from "../src/jwks";
import { HttpAnalyticsTransport } from "../src/analytics/transport";
import { AnalyticsEvent } from "../src/analytics/types";
import { SupertabConnect } from "../src/index";

const BASE_URL = "https://api-connect.test";

const fixtureEvent = {
  timestamp: "2026-04-29T12:00:00.000Z",
  request_id: "req-1",
  schema_version: 1,
  source_cdn: "fastly",
  path: "/p",
  method: "GET",
} as unknown as AnalyticsEvent;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fastlyEvent(url = "https://example.test/article") {
  return {
    request: new Request(url),
    client: { address: "1.2.3.4", geo: null, tlsJA3MD5: null },
    waitUntil: () => {},
  };
}

afterEach(() => {
  setConnectBackend(undefined);
  SupertabConnect.resetInstance();
  clearJwksCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect backend resolution", () => {
  it("defaults to stc-backend", () => {
    expect(getConnectBackend()).toBe("stc-backend");
  });

  it("returns the configured name once set, and the default again after a reset", () => {
    setConnectBackend("my-supertab-host");
    expect(getConnectBackend()).toBe("my-supertab-host");

    setConnectBackend(undefined);
    expect(getConnectBackend()).toBe("stc-backend");
  });

  it("treats a blank name as unset rather than routing to an empty backend", () => {
    setConnectBackend("   ");
    expect(getConnectBackend()).toBe("stc-backend");
  });

  it("trims surrounding whitespace", () => {
    setConnectBackend("  padded-backend  ");
    expect(getConnectBackend()).toBe("padded-backend");
  });

  it("omits the backend entirely off Fastly, where naming one is meaningless", () => {
    setConnectBackend("my-supertab-host");
    expect(connectBackend()).toBeUndefined();
    expect(withFastlyBackend({ method: "GET" })).toEqual({ method: "GET" });
  });

  it("adds the backend on Fastly without disturbing the other options", () => {
    vi.stubGlobal("fastly", {});
    setConnectBackend("my-supertab-host");

    expect(connectBackend()).toBe("my-supertab-host");
    expect(withFastlyBackend({ method: "POST", body: "x" })).toEqual({
      method: "POST",
      body: "x",
      backend: "my-supertab-host",
    });
  });
});

// One case per outbound Connect-API call, since each used to carry its own copy of the
// backend block and could drift independently.
describe("every Connect-API call honours the configured backend", () => {
  it("license.xml", async () => {
    vi.stubGlobal("fastly", {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("<rsl />", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setConnectBackend("my-supertab-host");

    await hostRSLicenseXML(BASE_URL, "urn:merchant-system:abc");

    expect(fetchMock.mock.calls[0][1].backend).toBe("my-supertab-host");
  });

  it("events", async () => {
    vi.stubGlobal("fastly", {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    setConnectBackend("my-supertab-host");

    await recordEvent({ apiKey: "k", baseUrl: BASE_URL, eventName: "e", properties: {} });

    expect(fetchMock.mock.calls[0][1].backend).toBe("my-supertab-host");
  });

  it("platform JWKS", async () => {
    vi.stubGlobal("fastly", {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    setConnectBackend("my-supertab-host");

    await fetchPlatformJwks(BASE_URL, false);

    expect(fetchMock.mock.calls[0][1].backend).toBe("my-supertab-host");
  });

  it("analytics relay", async () => {
    vi.stubGlobal("fastly", {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    setConnectBackend("my-supertab-host");

    new HttpAnalyticsTransport({ url: `${BASE_URL}/ingest/events`, apiKey: "k" }).emit(fixtureEvent);
    await flush();

    expect(fetchMock.mock.calls[0][1].backend).toBe("my-supertab-host");
  });
});

describe("fastlyHandleRequests", () => {
  it("applies the connectBackend option, leaving originBackend to carry viewer traffic", async () => {
    vi.stubGlobal("fastly", {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await SupertabConnect.fastlyHandleRequests(fastlyEvent(), "api-key", "content_origin", {
      connectBackend: "my-supertab-host",
    });

    expect(SupertabConnect.getConnectBackend()).toBe("my-supertab-host");
    // The two backends are separate: the origin forward still goes to originBackend.
    expect(fetchMock.mock.calls.at(-1)?.[1]?.backend).toBe("content_origin");
  });

  it("leaves the default in place when the option is omitted", async () => {
    vi.stubGlobal("fastly", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

    await SupertabConnect.fastlyHandleRequests(fastlyEvent(), "api-key", "content_origin");

    expect(SupertabConnect.getConnectBackend()).toBe("stc-backend");
  });
});
