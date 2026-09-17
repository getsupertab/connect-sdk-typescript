import { describe, it, expect } from "vitest";
import {
  resolveFastlyRequestUrl,
  DEFAULT_ORIGINAL_AUTHORITY_HEADER,
} from "../src/fastly-url";

// The shape a VCL → Compute chain delivers: the URL is the Compute service's own, because
// the backend's `override_host` replaced Host after VCL ran.
const COMPUTE_URL = "https://svc.edgecompute.app/article?a=1";

function req(headers: Record<string, string> = {}, url = COMPUTE_URL) {
  return new Request(url, { headers });
}

const authority = (value: string, extra: Record<string, string> = {}) =>
  req({ [DEFAULT_ORIGINAL_AUTHORITY_HEADER]: value, ...extra });

describe("resolveFastlyRequestUrl — grafting", () => {
  it("puts the preserved authority on the path and query Compute observed", () => {
    const { url, source } = resolveFastlyRequestUrl(authority("www.example.com"));
    expect(url.href).toBe("https://www.example.com/article?a=1");
    expect(source).toBe("authority-header");
  });

  it("keeps a path with no query intact", () => {
    const { url } = resolveFastlyRequestUrl(
      authority("www.example.com"),
    );
    expect(url.pathname).toBe("/article");
  });

  it("does not carry the compute authority into the result", () => {
    const { url } = resolveFastlyRequestUrl(authority("www.example.com"));
    expect(url.href).not.toContain("edgecompute.app");
  });
});

describe("resolveFastlyRequestUrl — precedence", () => {
  it("prefers the authority header over x-original-request-url", () => {
    const { url, source } = resolveFastlyRequestUrl(
      authority("www.example.com", { "x-original-request-url": "https://other.example/z?q=2" })
    );
    // Authority from the header, path and query from the observed request — not from the
    // forwarded URL, which is only consulted for the scheme.
    expect(url.href).toBe("https://www.example.com/article?a=1");
    expect(source).toBe("authority-header");
  });

  it("falls back to x-original-request-url when no authority header is present", () => {
    const { url, source } = resolveFastlyRequestUrl(
      req({ "x-original-request-url": "https://www.example.com/z?q=2" })
    );
    expect(url.href).toBe("https://www.example.com/z?q=2");
    expect(source).toBe("original-url-header");
  });

  it("falls back to request.url when neither header is present", () => {
    const { url, source } = resolveFastlyRequestUrl(req());
    expect(url.href).toBe(COMPUTE_URL);
    expect(source).toBe("request");
  });
});

describe("resolveFastlyRequestUrl — scheme", () => {
  it("takes the scheme from x-original-request-url when both headers are present", () => {
    const { url } = resolveFastlyRequestUrl(
      authority("www.example.com", { "x-original-request-url": "http://www.example.com/z" })
    );
    expect(url.href).toBe("http://www.example.com/article?a=1");
  });

  it("honours x-forwarded-proto when there is no forwarded URL", () => {
    const { url } = resolveFastlyRequestUrl(
      authority("www.example.com", { "x-forwarded-proto": "http" })
    );
    expect(url.protocol).toBe("http:");
  });

  it("ignores a nonsense x-forwarded-proto rather than building a bad URL", () => {
    const { url } = resolveFastlyRequestUrl(
      authority("www.example.com", { "x-forwarded-proto": "javascript" })
    );
    expect(url.protocol).toBe("https:");
  });

  it("assumes https when only the authority header is present", () => {
    const { url } = resolveFastlyRequestUrl(authority("www.example.com"));
    expect(url.protocol).toBe("https:");
  });
});

describe("resolveFastlyRequestUrl — header name", () => {
  it("honours a custom header name", () => {
    const request = req({ "x-supertab-viewer-host": "www.example.com" });
    const { url } = resolveFastlyRequestUrl(request, "x-supertab-viewer-host");
    expect(url.host).toBe("www.example.com");
  });

  it("ignores the default header once a custom name is configured", () => {
    const { url, source } = resolveFastlyRequestUrl(
      authority("www.example.com"),
      "x-supertab-viewer-host"
    );
    expect(url.href).toBe(COMPUTE_URL);
    expect(source).toBe("request");
  });

  it("matches the configured name case-insensitively", () => {
    const request = req({ "x-supertab-viewer-host": "www.example.com" });
    const { url } = resolveFastlyRequestUrl(request, "  X-Supertab-Viewer-Host  ");
    expect(url.host).toBe("www.example.com");
  });

  it("falls back to the default when the configured name is blank", () => {
    const { url } = resolveFastlyRequestUrl(authority("www.example.com"), "   ");
    expect(url.host).toBe("www.example.com");
  });
});

describe("resolveFastlyRequestUrl — normalization", () => {
  it("lowercases the host", () => {
    const { url } = resolveFastlyRequestUrl(authority("WWW.Example.COM"));
    expect(url.host).toBe("www.example.com");
  });

  it("keeps a non-default port", () => {
    const { url } = resolveFastlyRequestUrl(authority("www.example.com:8443"));
    expect(url.host).toBe("www.example.com:8443");
  });

  it("drops the default port for the scheme", () => {
    const { url } = resolveFastlyRequestUrl(authority("www.example.com:443"));
    expect(url.host).toBe("www.example.com");
  });

  it("strips a trailing dot so the audience prefix still matches", () => {
    const { url } = resolveFastlyRequestUrl(authority("www.example.com."));
    expect(url.href).toBe("https://www.example.com/article?a=1");
  });

  it("accepts a bracketed IPv6 literal", () => {
    const { url } = resolveFastlyRequestUrl(authority("[2001:db8::1]:8443"));
    expect(url.host).toBe("[2001:db8::1]:8443");
  });

  it("ignores an unbracketed IPv6 literal", () => {
    const { source } = resolveFastlyRequestUrl(authority("2001:db8::1"));
    expect(source).toBe("request");
  });
});

describe("resolveFastlyRequestUrl — rejection", () => {
  // Each bad value must fall through to the next source rather than throw or, worse, parse
  // into a plausible-looking wrong host: `new URL("https://" + "https://evil/x")` has host
  // "https", which would silently become the license audience.
  const rejected: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace-only", "   "],
    ["a full URL", "https://evil.example/x"],
    ["a scheme-relative URL", "//evil.example"],
    ["a path", "www.example.com/admin"],
    ["a query", "www.example.com?a=1"],
    ["a fragment", "www.example.com#f"],
    ["userinfo", "user:pass@evil.example"],
    ["a comma-joined hop list", "www.example.com, evil.example"],
    ["embedded whitespace", "www.example.com evil.example"],
    ["a backslash", "www.example.com\\evil.example"],
    ["an over-long value", `${"a".repeat(256)}.example`],
    ["a bare port", ":8443"],
  ];

  for (const [label, value] of rejected) {
    it(`ignores ${label}`, () => {
      const { url, source } = resolveFastlyRequestUrl(authority(value));
      expect(url.href).toBe(COMPUTE_URL);
      expect(source).toBe("request");
    });
  }

  it("falls through to x-original-request-url when the authority is unusable", () => {
    const { url, source } = resolveFastlyRequestUrl(
      authority("https://evil.example/x", {
        "x-original-request-url": "https://www.example.com/z",
      })
    );
    expect(url.href).toBe("https://www.example.com/z");
    expect(source).toBe("original-url-header");
  });

  it("does not throw when x-original-request-url is not a valid URL", () => {
    // Previously this threw out of handleFastlyRequest into the fail-open path, silently
    // dropping enforcement for the request.
    const { url, source } = resolveFastlyRequestUrl(req({ "x-original-request-url": "not a url" }));
    expect(url.href).toBe(COMPUTE_URL);
    expect(source).toBe("request");
  });

  it("still uses the authority header when the forwarded URL is malformed", () => {
    const { url } = resolveFastlyRequestUrl(
      authority("www.example.com", { "x-original-request-url": "not a url" })
    );
    expect(url.href).toBe("https://www.example.com/article?a=1");
  });
});
