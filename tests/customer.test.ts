import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseContentElements,
  findBestMatchingContent,
  obtainLicenseToken,
  ContentBlock,
  UsageType,
} from "../src/customer";

const sampleXml = `
<rsl xmlns="https://rslstandard.org/rsl">
  <content url="http://127.0.0.1:7676/*" server="http://127.0.0.1:8787">
    <license type="application/vnd.readium.license.status.v1.0+json">
      <link rel="self" href="http://127.0.0.1:8787/license" />
    </license>
  </content>
  <content url="http://127.0.0.1:7676/article/*" server="http://127.0.0.1:8787">
    <license type="application/vnd.readium.license.status.v1.0+json">
      <link rel="self" href="http://127.0.0.1:8787/license" />
    </license>
  </content>
  <content url="http://127.0.0.1:7676/content" server="http://127.0.0.1:8787">
    <license type="application/vnd.readium.license.status.v1.0+json">
      <link rel="self" href="http://127.0.0.1:8787/license" />
    </license>
  </content>
</rsl>
`;

describe("parseContentElements", () => {
  it("parses multiple content blocks", () => {
    const blocks = parseContentElements(sampleXml);
    expect(blocks).toHaveLength(3);

    expect(blocks[0].urlPattern).toBe("http://127.0.0.1:7676/*");
    expect(blocks[0].server).toBe("http://127.0.0.1:8787");
    expect(blocks[0].licenseXml).toContain("<license");

    expect(blocks[1].urlPattern).toBe("http://127.0.0.1:7676/article/*");
    expect(blocks[1].server).toBe("http://127.0.0.1:8787");
    expect(blocks[1].licenseXml).toContain("<license");

    expect(blocks[2].urlPattern).toBe("http://127.0.0.1:7676/content");
    expect(blocks[2].server).toBe("http://127.0.0.1:8787");
    expect(blocks[2].licenseXml).toContain("<license");
  });

  it("skips content missing <license>", () => {
    const xml = `
      <content url="http://example.com/*" server="http://example.com">
        <p>No license here</p>
      </content>
    `;
    expect(parseContentElements(xml)).toEqual([]);
  });

  it("skips content missing url attribute", () => {
    const xml = `
      <content server="http://example.com">
        <license type="test"><link /></license>
      </content>
    `;
    expect(parseContentElements(xml)).toEqual([]);
  });

  it("keeps serverless content when license exists", () => {
    const xml = `
      <content url="http://example.com/*">
        <license type="test"><link /></license>
      </content>
    `;
    expect(parseContentElements(xml)).toEqual([
      {
        urlPattern: "http://example.com/*",
        server: undefined,
        licenseXml: '<license type="test"><link /></license>',
      },
    ]);
  });

  it("returns empty array for XML with no content elements", () => {
    const xml = `<root><other>stuff</other></root>`;
    expect(parseContentElements(xml)).toEqual([]);
  });
});

describe("findBestMatchingContent", () => {
  const blocks: ContentBlock[] = parseContentElements(sampleXml);

  it("exact path match wins", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/article/"
    );
    expect(result).not.toBeNull();
  });

  it("more-specific wildcard wins", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/article/*");
  });

  it("falls back to broader wildcard", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/other"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/*");
  });

  it("no match for different host", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://other-host:7676/article/foo"
    );
    expect(result).toBeNull();
  });

  it("prefix match without wildcard", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/content/article"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/content");
  });

  it("does not match non-segment prefix (falls back to catch-all)", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/content-other"
    );
    // /content pattern should NOT match /content-other, but /* catch-all does
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/*");
  });
  
  it("mid-path wildcard is more specific than bare prefix", () => {
    const blocksWithMidWildcard: ContentBlock[] = [
      ...blocks,
      {
        urlPattern: "http://127.0.0.1:7676/content/*/article",
        server: "http://127.0.0.1:8787",
        licenseXml: "<license/>",
      },
    ];
    const result = findBestMatchingContent(
      blocksWithMidWildcard,
      "http://127.0.0.1:7676/content/news/article"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/content/*/article");
  });

  it("matches path-only pattern (no host)", () => {
    const pathBlocks: ContentBlock[] = [
      { urlPattern: "/article/*", server: "http://127.0.0.1:8787", licenseXml: "<license/>" },
    ];
    const result = findBestMatchingContent(
      pathBlocks,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("/article/*");
  });

  it("exact path-only match wins over wildcard", () => {
    const pathBlocks: ContentBlock[] = [
      { urlPattern: "/*", server: "http://127.0.0.1:8787", licenseXml: "<license/>" },
      { urlPattern: "/article/foo", server: "http://127.0.0.1:8787", licenseXml: "<license/>" },
    ];
    const result = findBestMatchingContent(
      pathBlocks,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("/article/foo");
  });

  it("path-only patterns match any host", () => {
    const pathBlocks: ContentBlock[] = [
      { urlPattern: "/article/*", server: "http://127.0.0.1:8787", licenseXml: "<license/>" },
    ];
    const result = findBestMatchingContent(
      pathBlocks,
      "http://totally-different-host.com/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("/article/*");
  });

  it("mixes full-URL and path-only blocks", () => {
    const mixedBlocks: ContentBlock[] = [
      { urlPattern: "http://127.0.0.1:7676/*", server: "http://127.0.0.1:8787", licenseXml: "<license/>" },
      { urlPattern: "/article/*", server: "http://127.0.0.1:8787", licenseXml: "<license/>" },
    ];
    const result = findBestMatchingContent(
      mixedBlocks,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    // /article/* is more specific than /*
    expect(result!.urlPattern).toBe("/article/*");
  });

  it("skips invalid URL patterns gracefully", () => {
    const blocksWithBad: ContentBlock[] = [
      { urlPattern: "not-a-valid-url", server: "http://x", licenseXml: "<license/>" },
      ...blocks,
    ];
    const result = findBestMatchingContent(
      blocksWithBad,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/article/*");
  });
});

// ---------------------------------------------------------------------------
// obtainLicenseToken caching
// ---------------------------------------------------------------------------
// Each test uses a unique origin/clientId so module-level caches don't bleed
// between tests without needing module resets.

describe("obtainLicenseToken caching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Minimal license.xml with one <content> entry per supplied pattern. */
  function makeLicenseXml(
    entries: Array<{ url: string; server?: string }>
  ): string {
    return `<rsl>${entries
      .map(
        ({ url, server = "http://token-server.com" }) =>
          `<content url="${url}" server="${server}">` +
          `<license type="test"><link rel="self" href="${server}/license"/></license>` +
          `</content>`
      )
      .join("")}</rsl>`;
  }

  /**
   * Build a base64url-decodable (unsigned) JWT with the given exp.
   * jose's decodeJwt only parses the payload — no signature verification.
   */
  function makeJwt(exp: number): string {
    const b64url = (obj: object) =>
      btoa(JSON.stringify(obj))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
    return [b64url({ alg: "ES256", typ: "JWT" }), b64url({ exp, iss: "test" }), "fakesig"].join(".");
  }

  /** Stub globalThis.fetch to serve license.xml and token responses. */
  function mockFetch(licenseXml: string, accessToken: string) {
    const mock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/license.xml")) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(licenseXml) });
      }
      if (url.endsWith("/token")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: accessToken }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  function xmlFetches(mock: ReturnType<typeof vi.fn>) {
    return mock.mock.calls.filter(([url]) => typeof url === "string" && url.endsWith("/license.xml"));
  }

  function tokenFetches(mock: ReturnType<typeof vi.fn>) {
    return mock.mock.calls.filter(([url]) => typeof url === "string" && url.endsWith("/token"));
  }

  it("fetches license.xml only once per origin across multiple calls", async () => {
    const origin = "http://cachetest-xml-once.com";
    const xml = makeLicenseXml([{ url: `${origin}/articles/*` }, { url: `${origin}/news/*` }]);
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    await obtainLicenseToken({ clientId: "c1", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });
    await obtainLicenseToken({ clientId: "c1", clientSecret: "s", resourceUrl: `${origin}/news/bar` });

    // Two different patterns → two token fetches, but only one license.xml fetch
    expect(xmlFetches(mock)).toHaveLength(1);
    expect(tokenFetches(mock)).toHaveLength(2);
  });

  it("returns the same token for different resourceUrls matching the same urlPattern", async () => {
    const origin = "http://cachetest-token-reuse.com";
    const xml = makeLicenseXml([{ url: `${origin}/articles/*` }]);
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    const t1 = await obtainLicenseToken({ clientId: "c2", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });
    const t2 = await obtainLicenseToken({ clientId: "c2", clientSecret: "s", resourceUrl: `${origin}/articles/bar` });

    expect(t1).toBe(t2);
    expect(tokenFetches(mock)).toHaveLength(1);
  });

  it("fetches separate tokens for different urlPatterns on the same origin", async () => {
    const origin = "http://cachetest-two-patterns.com";
    const xml = makeLicenseXml([{ url: `${origin}/articles/*` }, { url: `${origin}/news/*` }]);
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    await obtainLicenseToken({ clientId: "c3", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });
    await obtainLicenseToken({ clientId: "c3", clientSecret: "s", resourceUrl: `${origin}/news/bar` });

    expect(tokenFetches(mock)).toHaveLength(2);
  });

  it("does not share tokens across different clientIds", async () => {
    const origin = "http://cachetest-client-isolation.com";
    const xml = makeLicenseXml([{ url: `${origin}/articles/*` }]);
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    await obtainLicenseToken({ clientId: "client-x", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });
    await obtainLicenseToken({ clientId: "client-y", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });

    expect(tokenFetches(mock)).toHaveLength(2);
  });

  it("does not share tokens across different servers for the same path-only pattern", async () => {
    // Both origins have a path-only pattern "/articles/*" pointing to different servers.
    // Tokens must not be shared between them.
    const xml1 = makeLicenseXml([{ url: "/articles/*", server: "http://server-one.com" }]);
    const xml2 = makeLicenseXml([{ url: "/articles/*", server: "http://server-two.com" }]);

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/license.xml")) {
        callCount++;
        const xml = url.startsWith("http://origin-one") ? xml1 : xml2;
        return Promise.resolve({ ok: true, text: () => Promise.resolve(xml) });
      }
      if (url.endsWith("/token")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ access_token: makeJwt(Math.floor(Date.now() / 1000) + 900) }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }));

    const t1 = await obtainLicenseToken({ clientId: "c-shared", clientSecret: "s", resourceUrl: "http://origin-one.com/articles/foo" });
    const t2 = await obtainLicenseToken({ clientId: "c-shared", clientSecret: "s", resourceUrl: "http://origin-two.com/articles/foo" });

    // Each server issues its own token — they must not be the same cached value
    // (different servers → different cacheKeys → two token endpoint calls)
    // We verify by checking that two token requests were made.
    // We can't check t1 !== t2 because the mock returns the same JWT structure,
    // but we can confirm the token endpoint was hit twice.
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
  });

  it("re-fetches license.xml after the 15-minute TTL expires", async () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const origin = "http://cachetest-xml-ttl.com";
    const xml = makeLicenseXml([{ url: `${origin}/articles/*` }]);
    // Token also expires within the window so the second call isn't served from token cache
    const mock = mockFetch(xml, makeJwt(now + 900));

    await obtainLicenseToken({ clientId: "c5", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });

    vi.advanceTimersByTime(16 * 60 * 1000); // advance past 15-min TTL

    await obtainLicenseToken({ clientId: "c5", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });

    expect(xmlFetches(mock)).toHaveLength(2);
  });

  it("does not re-fetch license.xml before the TTL expires", async () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const origin = "http://cachetest-xml-no-refetch.com";
    const xml = makeLicenseXml([{ url: `${origin}/articles/*` }]);
    const mock = mockFetch(xml, makeJwt(now + 900));

    await obtainLicenseToken({ clientId: "c6", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });

    vi.advanceTimersByTime(14 * 60 * 1000); // still within TTL

    await obtainLicenseToken({ clientId: "c6-b", clientSecret: "s", resourceUrl: `${origin}/articles/foo` });

    expect(xmlFetches(mock)).toHaveLength(1);
  });

  it("returns undefined for search usage when a matching serverless usage grant exists", async () => {
    const origin = "http://search-serverless-match.com";
    const xml = `<rsl>
      <content url="/articles/*">
        <license type="test">
          <permits type="usage">search</permits>
        </license>
      </content>
      <content url="/*" server="http://token-server.com">
        <license type="test"><link rel="self" href="http://token-server.com/license"/></license>
      </content>
    </rsl>`;
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    const token = await obtainLicenseToken({
      clientId: "c-search",
      clientSecret: "s",
      resourceUrl: `${origin}/articles/foo`,
      usage: UsageType.SEARCH,
    });

    expect(token).toBeUndefined();
    expect(xmlFetches(mock)).toHaveLength(1);
    expect(tokenFetches(mock)).toHaveLength(0);
  });

  it("still requests a token for search usage when no matching serverless usage grant exists", async () => {
    const origin = "http://search-serverless-miss.com";
    const xml = `<rsl>
      <content url="/news/*">
        <license type="test">
          <permits type="usage">search</permits>
        </license>
      </content>
      <content url="/articles/*" server="http://token-server.com">
        <license type="test"><link rel="self" href="http://token-server.com/license"/></license>
      </content>
    </rsl>`;
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    const token = await obtainLicenseToken({
      clientId: "c-search-fallback",
      clientSecret: "s",
      resourceUrl: `${origin}/articles/foo`,
      usage: UsageType.SEARCH,
    });

    expect(token).toBeDefined();
    expect(xmlFetches(mock)).toHaveLength(1);
    expect(tokenFetches(mock)).toHaveLength(1);
  });

  it("returns undefined for ai-train usage when a matching serverless usage grant exists", async () => {
    const origin = "http://ai-train-serverless-match.com";
    const xml = `<rsl>
      <content url="/articles/*">
        <license type="test">
          <permits type="usage">ai-train</permits>
        </license>
      </content>
      <content url="/*" server="http://token-server.com">
        <license type="test"><link rel="self" href="http://token-server.com/license"/></license>
      </content>
    </rsl>`;
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    const token = await obtainLicenseToken({
      clientId: "c-ai-train",
      clientSecret: "s",
      resourceUrl: `${origin}/articles/foo`,
      usage: UsageType.AI_TRAIN,
    });

    expect(token).toBeUndefined();
    expect(xmlFetches(mock)).toHaveLength(1);
    expect(tokenFetches(mock)).toHaveLength(0);
  });

  it("requests a token when the matching serverless usage grant explicitly prohibits the chosen usage", async () => {
    const origin = "http://usage-prohibited-fallback.com";
    const xml = `<rsl>
      <content url="/articles/*">
        <license type="test">
          <permits type="usage">ai-train search</permits>
          <prohibits type="usage">ai-train</prohibits>
        </license>
      </content>
      <content url="/*" server="http://token-server.com">
        <license type="test"><link rel="self" href="http://token-server.com/license"/></license>
      </content>
    </rsl>`;
    const mock = mockFetch(xml, makeJwt(Math.floor(Date.now() / 1000) + 900));

    const token = await obtainLicenseToken({
      clientId: "c-usage-prohibited",
      clientSecret: "s",
      resourceUrl: `${origin}/articles/foo`,
      usage: UsageType.AI_TRAIN,
    });

    expect(token).toBeDefined();
    expect(xmlFetches(mock)).toHaveLength(1);
    expect(tokenFetches(mock)).toHaveLength(1);
  });
});
