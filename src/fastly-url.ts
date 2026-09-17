/** Header the VCL service stamps with the viewer's authority, unless the caller renames it. */
export const DEFAULT_ORIGINAL_AUTHORITY_HEADER = "x-supertab-original-authority";

/** Full viewer URL, the pre-existing contract. Kept as a fallback for chains already on it. */
const ORIGINAL_URL_HEADER = "x-original-request-url";

// A host[:port] and nothing else. Anything longer is not an authority a VCL service produced,
// and the cap keeps a hostile value from reaching the URL parser at all.
const MAX_AUTHORITY_LENGTH = 255;

// Characters that cannot appear in a bare authority. Rejecting them is what stops a full URL,
// a path, userinfo, or a comma-joined multi-hop value from being parsed into something that
// *looks* like a host: `new URL("https://" + "https://evil/x")` yields the host "https".
const NOT_AN_AUTHORITY = /[\s/\\?#@,]/;

export type FastlyUrlSource = "authority-header" | "original-url-header" | "request";

export interface ResolvedFastlyUrl {
  /** Always parseable, so callers never re-parse or guard. */
  url: URL;
  /** Which branch produced `url`. Diagnostics and tests only — nothing branches on it. */
  source: FastlyUrlSource;
}

function safeUrl(value: string | null | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize a bare `host[:port]` header value, or null when it is not one.
 *
 * Validation is by parsing rather than by pattern: the reject-list above removes the shapes
 * that would parse into a misleading host, and the emptiness checks afterwards catch the rest.
 * Normalization (lowercasing, default-port removal, IDN → A-labels) is the URL parser's, so it
 * matches what the audience comparison in license.ts will see.
 */
function normalizeAuthority(value: string | null): string | null {
  const raw = value?.trim();
  if (!raw || raw.length > MAX_AUTHORITY_LENGTH) return null;
  if (NOT_AN_AUTHORITY.test(raw)) return null;

  let parsed: URL;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;
  // A value that contributed anything beyond an authority is not one, whatever it parsed to.
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  if (parsed.username || parsed.password) return null;

  // A fully-qualified "example.com." is the same host as "example.com", but a string prefix
  // match against an audience of "https://example.com/" would never see it that way.
  const hostname = parsed.hostname.endsWith(".") ? parsed.hostname.slice(0, -1) : parsed.hostname;
  if (!hostname) return null;
  return parsed.port ? `${hostname}:${parsed.port}` : hostname;
}

/**
 * Recover the viewer's URL on Fastly, for both topologies:
 *
 * - **VCL → Compute chain**: the VCL backend's `override_host` replaces `Host` with the Compute
 *   service's `*.edgecompute.app` domain *after* VCL runs, so `request.url`'s authority is the
 *   hop's. The VCL service preserves the viewer's authority in a dedicated header; we graft it
 *   onto the path and query Compute observed. The older full-URL `x-original-request-url` header
 *   still works, and supplies the scheme when both are present.
 * - **Compute-only**: neither header is set, and `request.url` is already the viewer's.
 *
 * Never throws: a malformed header is ignored and resolution falls through to the next source,
 * so a bad value costs the authority rather than the enforcement decision.
 */
export function resolveFastlyRequestUrl(
  request: Request,
  originalAuthorityHeader?: string
): ResolvedFastlyUrl {
  const observed = new URL(request.url);
  const forwarded = safeUrl(request.headers.get(ORIGINAL_URL_HEADER));

  const headerName =
    originalAuthorityHeader?.trim().toLowerCase() || DEFAULT_ORIGINAL_AUTHORITY_HEADER;
  const authority = normalizeAuthority(request.headers.get(headerName));

  if (authority) {
    // The forwarded URL is the only in-band record of whether the viewer arrived over TLS;
    // x-forwarded-proto is the portable fallback, and https the default every license audience
    // and status-probe origin is issued with.
    const forwardedProto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
    const scheme =
      forwarded?.protocol === "http:" || forwarded?.protocol === "https:"
        ? forwarded.protocol
        : forwardedProto === "http" || forwardedProto === "https"
          ? `${forwardedProto}:`
          : "https:";

    const url = new URL(`${scheme}//${authority}`);
    url.pathname = observed.pathname;
    url.search = observed.search;
    return { url, source: "authority-header" };
  }

  if (forwarded) return { url: forwarded, source: "original-url-header" };
  return { url: observed, source: "request" };
}
