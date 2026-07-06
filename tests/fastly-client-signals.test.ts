import { describe, it, expect } from "vitest";
import { resolveFastlyClientSignals } from "../src/index";

// Minimal FastlyFetchEvent stub. `fastly:geolocation` isn't importable outside the
// Compute runtime, so the header path's geo lookup fails closed to null here — which
// is exactly the fallback behavior we want to assert.
function fakeEvent(opts: {
  headers?: Record<string, string>;
  client?: { address?: string; geo?: { country_code: string | null; as_number: number | null } | null; tlsJA3MD5?: string | null };
}): any {
  return {
    request: new Request("https://example.com/", { headers: opts.headers ?? {} }),
    client: {
      address: opts.client?.address ?? "10.0.0.1",
      geo: opts.client?.geo ?? { country_code: "US", as_number: 7018 },
      tlsJA3MD5: opts.client?.tlsJA3MD5 ?? "ja3-hop",
    },
    waitUntil: () => {},
  };
}

describe("resolveFastlyClientSignals", () => {
  it("compute-only (no Fastly-Client-IP): uses event.client for IP, geo, and JA3", async () => {
    const signals = await resolveFastlyClientSignals(
      fakeEvent({ client: { address: "203.0.113.5", geo: { country_code: "DE", as_number: 3320 }, tlsJA3MD5: "real-ja3" } })
    );
    expect(signals).toEqual({
      clientIp: "203.0.113.5",
      requestCountry: "DE",
      requestAsn: 3320,
      tlsFingerprint: "real-ja3",
    });
  });

  it("chained (Fastly-Client-IP present): takes the header IP and drops the hop's JA3", async () => {
    const signals = await resolveFastlyClientSignals(
      fakeEvent({
        headers: { "fastly-client-ip": "198.51.100.7" },
        // event.client is the upstream Fastly hop here — must be ignored.
        client: { address: "23.235.0.1", geo: { country_code: "US", as_number: 54113 }, tlsJA3MD5: "hop-ja3" },
      })
    );
    expect(signals.clientIp).toBe("198.51.100.7");
    expect(signals.tlsFingerprint).toBeNull();
    // Geo derives from the header IP via fastly:geolocation, unavailable in tests → null
    // (never the hop's 54113 / US).
    expect(signals.requestAsn).toBeNull();
    expect(signals.requestCountry).toBeNull();
  });
});
