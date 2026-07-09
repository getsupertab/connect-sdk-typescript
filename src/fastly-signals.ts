import { FastlyFetchEvent } from "./types";

export interface FastlyClientSignals {
  clientIp: string;
  requestCountry: string | null;
  requestAsn: number | null;
  tlsFingerprint: string | null;
}

// Cached across requests: undefined = not yet loaded, null = load failed (don't retry).
// fastly:geolocation is a runtime built-in, kept external by tsup.
let getGeolocationForIpAddress:
  | ((address: string) => { country_code: string | null; as_number: number | null } | null)
  | null
  | undefined;

/**
 * Resolve the viewer's IP / geo / JA3 on Fastly, working for both topologies:
 *
 * - **VCL → Compute chain** (most deployments): `event.client.*` is the upstream Fastly
 *   hop, not the viewer. The real client IP is forwarded in `Fastly-Client-IP` (it persists
 *   across Fastly hops). When that header is present we take it as the source of truth and
 *   derive country/ASN from it via `fastly:geolocation`. JA3 is dropped — `event.client`'s
 *   TLS is the hop's, not the viewer's, and there's no viewer JA3 on this path.
 * - **Compute-only** (direct): no `Fastly-Client-IP` header, so `event.client.*` is the
 *   real, unspoofable connection info — use it directly.
 *
 * Note: on a direct deployment a client could spoof `Fastly-Client-IP`. That only pollutes
 * its own analytics row (IP is never used for enforcement). Chained deployments should
 * harden the header at the VCL edge (`set req.http.Fastly-Client-IP = client.ip;`).
 */
export async function resolveFastlyClientSignals(event: FastlyFetchEvent): Promise<FastlyClientSignals> {
  const headerIp = event.request.headers.get("fastly-client-ip");
  if (headerIp) {
    if (getGeolocationForIpAddress === undefined) {
      try {
        ({ getGeolocationForIpAddress } = await import("fastly:geolocation"));
      } catch {
        getGeolocationForIpAddress = null;
      }
    }
    const geo = getGeolocationForIpAddress?.(headerIp) ?? null;
    return {
      clientIp: headerIp,
      requestCountry: geo?.country_code ?? null,
      requestAsn: geo?.as_number ?? null,
      tlsFingerprint: null,
    };
  }
  const client = event.client;
  return {
    clientIp: client.address,
    requestCountry: client.geo?.country_code ?? null,
    requestAsn: client.geo?.as_number ?? null,
    tlsFingerprint: client.tlsJA3MD5 ?? null,
  };
}
