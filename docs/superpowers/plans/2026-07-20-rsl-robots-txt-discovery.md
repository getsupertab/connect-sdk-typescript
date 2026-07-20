# RSL robots.txt Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the customer SDK's `obtainLicenseToken` resolve a merchant's RSL license via the `robots.txt` `License:` directive when the origin doesn't self-host `/license.xml`, so passive/deferred-CAP merchants (e.g. inverse.com) work out of the box.

**Architecture:** Rework `fetchLicenseXml` in `src/customer.ts` to be origin-first: try `${origin}/license.xml` (today's behavior), and only on failure fetch `${origin}/robots.txt`, parse its `License:` directives, and follow them in document order — selecting the first that yields a mintable content block for the requested resource. Resolved XML is cached by origin exactly as today, so the robots.txt hop happens at most once per origin per TTL.

**Tech Stack:** TypeScript, vitest (`vitest run`), global `fetch` stubbed via `vi.stubGlobal`.

## Global Constraints

- Language: TypeScript; test runner: **vitest** (`npm test` → `vitest run`).
- All code lives in `src/customer.ts`; all tests in `tests/customer.test.ts`.
- HTTP requests use `fetch` with header `{ "User-Agent": SDK_USER_AGENT }` (already imported in `customer.ts`).
- License.xml is cached by **origin** with TTL `LICENSE_XML_TTL_SECONDS` (15 min) via the existing `licenseXmlCache` map and `evictExpiredLicenseXml()`.
- Reuse existing exported helpers `parseContentElements(xml, debug)` and `findBestMatchingContent(blocks, resourceUrl, debug)` — do not reimplement content matching.
- A content block is **mintable** when it has a truthy `server` and `findBestMatchingContent` matches it to the resource.
- No new runtime dependencies. No changes outside `src/customer.ts` / `tests/customer.test.ts`.

---

### Task 1: robots.txt `License:` directive parser

A pure function that extracts RSL `License:` directive URLs from a robots.txt body, in document order. No fetching — string in, URLs out.

**Files:**
- Modify: `src/customer.ts` (add function near `fetchLicenseXml`, ~line 238; add to the existing `export { parseContentElements, findBestMatchingContent };` line ~396)
- Test: `tests/customer.test.ts` (new `describe` block)

**Interfaces:**
- Produces: `parseRobotsLicenseDirectives(robotsTxt: string): string[]` — exported.

- [ ] **Step 1: Write the failing tests**

Add near the top-level `describe` blocks in `tests/customer.test.ts`, and add `parseRobotsLicenseDirectives` to the existing import from `../src/customer`:

```ts
describe("parseRobotsLicenseDirectives", () => {
  it("extracts a single License directive", () => {
    expect(parseRobotsLicenseDirectives("License: https://x.com/license.xml")).toEqual([
      "https://x.com/license.xml",
    ]);
  });

  it("preserves document order for multiple directives", () => {
    const robots = ["License: https://a.com/attribution.xml", "License: https://b.com/license.xml"].join("\n");
    expect(parseRobotsLicenseDirectives(robots)).toEqual([
      "https://a.com/attribution.xml",
      "https://b.com/license.xml",
    ]);
  });

  it("is case-insensitive on the directive name", () => {
    expect(parseRobotsLicenseDirectives("license: https://x.com/l.xml")).toEqual(["https://x.com/l.xml"]);
  });

  it("ignores blank lines, comments, and unrelated directives", () => {
    const robots = ["# comment", "User-agent: *", "Disallow: /private", "", "License: https://x.com/l.xml"].join("\n");
    expect(parseRobotsLicenseDirectives(robots)).toEqual(["https://x.com/l.xml"]);
  });

  it("returns an empty array when no License directive is present", () => {
    expect(parseRobotsLicenseDirectives("User-agent: *\nDisallow: /")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/customer.test.ts -t "parseRobotsLicenseDirectives"`
Expected: FAIL — `parseRobotsLicenseDirectives is not a function` / import error.

- [ ] **Step 3: Implement the parser**

Add to `src/customer.ts` (place it just above `fetchLicenseXml`):

```ts
/**
 * Extract RSL `License:` directive URLs from a robots.txt body, in document order.
 * The directive is site-level, so user-agent grouping is ignored. A URL cannot
 * contain whitespace, so `\S+` naturally stops before any trailing inline comment.
 */
export function parseRobotsLicenseDirectives(robotsTxt: string): string[] {
  const urls: string[] = [];
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^license\s*:\s*(\S+)/i);
    if (match) urls.push(match[1]);
  }
  return urls;
}
```

Add `parseRobotsLicenseDirectives` to the export list (~line 396):

```ts
export { parseContentElements, findBestMatchingContent, parseRobotsLicenseDirectives };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tests/customer.test.ts -t "parseRobotsLicenseDirectives"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/customer.ts tests/customer.test.ts
git commit -m "feat(customer): parse RSL License directives from robots.txt"
```

---

### Task 2: origin-first license.xml discovery with robots.txt fallback

Rework `fetchLicenseXml` so a failed origin fetch falls back to robots.txt discovery, following `License:` directives in order and selecting the first that yields a mintable block for the resource. Distinct errors for "nothing discoverable" vs "only non-mintable offered".

**Files:**
- Modify: `src/customer.ts` — replace `fetchLicenseXml` (currently ~lines 197-238) and add three helpers
- Test: `tests/customer.test.ts` (new `describe("license discovery (robots.txt)")` block)

**Interfaces:**
- Consumes: `parseRobotsLicenseDirectives` (Task 1); `parseContentElements`, `findBestMatchingContent` (existing); `licenseXmlCache`, `evictExpiredLicenseXml`, `LICENSE_XML_TTL_SECONDS`, `SDK_USER_AGENT` (existing).
- Produces: `fetchLicenseXml(resourceUrl: string, debug: boolean | undefined): Promise<string>` — unchanged signature; called by `obtainLicenseToken`. Behavior extended per this task.

- [ ] **Step 1: Write the failing tests**

Add this block to `tests/customer.test.ts`. It defines its own URL-routed fetch mock (the existing `mockFetch` matches on `endsWith("/license.xml")`, which can't distinguish the origin path from an API-hosted license.xml — discovery needs full-URL routing):

```ts
describe("license discovery (robots.txt)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const makeJwt = (exp: number) => {
    const b64url = (o: object) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    return [b64url({ alg: "ES256", typ: "JWT" }), b64url({ exp, iss: "test" }), "sig"].join(".");
  };

  // A content block; omit `server` to make it non-mintable.
  const block = (url: string, server?: string) =>
    server
      ? `<content url="${url}" server="${server}"><license type="t"><link rel="self" href="${server}/license"/></license></content>`
      : `<content url="${url}"><license type="t"/></content>`;
  const rsl = (...blocks: string[]) => `<rsl>${blocks.join("")}</rsl>`;

  type Route = { ok?: boolean; status?: number; body?: string };

  /** Stub fetch with exact-URL routing; unmatched `/token` URLs return a valid JWT. */
  function mockRoutes(routes: Record<string, Route>) {
    const mock = vi.fn().mockImplementation((url: string) => {
      const r = routes[url];
      if (r) {
        const ok = r.ok ?? true;
        return Promise.resolve({
          ok,
          status: r.status ?? (ok ? 200 : 404),
          text: () => Promise.resolve(r.body ?? ""),
        });
      }
      if (typeof url === "string" && url.endsWith("/token")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: makeJwt(Math.floor(Date.now() / 1000) + 900) }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  const called = (mock: ReturnType<typeof vi.fn>, url: string) =>
    mock.mock.calls.some(([u]) => u === url);

  it("uses origin /license.xml and never fetches robots.txt when origin serves it", async () => {
    const origin = "http://disc-origin-served.com";
    const mock = mockRoutes({
      [`${origin}/license.xml`]: { body: rsl(block(`${origin}/articles/*`, "http://mint.test")) },
    });

    const token = await obtainLicenseToken({ clientId: "d1", clientSecret: "s", resourceUrl: `${origin}/articles/x` });

    expect(token).toBeDefined();
    expect(called(mock, `${origin}/robots.txt`)).toBe(false);
  });

  it("falls back to a robots.txt License directive when origin returns 404", async () => {
    const origin = "http://disc-fallback.com";
    const licUrl = "https://api.test/systems/abc/license.xml";
    const mock = mockRoutes({
      [`${origin}/license.xml`]: { ok: false, status: 404 },
      [`${origin}/robots.txt`]: { body: `License: ${licUrl}` },
      [licUrl]: { body: rsl(block(`${origin}/articles/*`, "http://mint.test")) },
    });

    const token = await obtainLicenseToken({ clientId: "d2", clientSecret: "s", resourceUrl: `${origin}/articles/x` });

    expect(token).toBeDefined();
    expect(called(mock, `${origin}/robots.txt`)).toBe(true);
    expect(called(mock, licUrl)).toBe(true);
  });

  it("skips a non-mintable directive and selects the first mintable one", async () => {
    const origin = "http://disc-first-mintable.com";
    const attrUrl = "https://attr.test/attribution.xml";
    const paidUrl = "https://api.test/license.xml";
    const mock = mockRoutes({
      [`${origin}/license.xml`]: { ok: false, status: 404 },
      [`${origin}/robots.txt`]: { body: [`License: ${attrUrl}`, `License: ${paidUrl}`].join("\n") },
      [attrUrl]: { body: rsl(block(`${origin}/articles/*`)) }, // no server -> non-mintable
      [paidUrl]: { body: rsl(block(`${origin}/articles/*`, "http://mint.test")) },
    });

    const token = await obtainLicenseToken({ clientId: "d3", clientSecret: "s", resourceUrl: `${origin}/articles/x` });

    expect(token).toBeDefined();
    expect(called(mock, attrUrl)).toBe(true); // tried first, in order
    expect(called(mock, paidUrl)).toBe(true);
  });

  it("early-returns on the first mintable directive without fetching later ones", async () => {
    const origin = "http://disc-early-return.com";
    const paidUrl = "https://api.test/license.xml";
    const laterUrl = "https://later.test/license.xml";
    const mock = mockRoutes({
      [`${origin}/license.xml`]: { ok: false, status: 404 },
      [`${origin}/robots.txt`]: { body: [`License: ${paidUrl}`, `License: ${laterUrl}`].join("\n") },
      [paidUrl]: { body: rsl(block(`${origin}/articles/*`, "http://mint.test")) },
      [laterUrl]: { body: rsl(block(`${origin}/articles/*`, "http://mint2.test")) },
    });

    await obtainLicenseToken({ clientId: "d4", clientSecret: "s", resourceUrl: `${origin}/articles/x` });

    expect(called(mock, paidUrl)).toBe(true);
    expect(called(mock, laterUrl)).toBe(false); // never fetched
  });

  it("throws a non-mintable error when directives offer only non-mintable licenses", async () => {
    const origin = "http://disc-nonmintable.com";
    const attrUrl = "https://attr.test/attribution.xml";
    mockRoutes({
      [`${origin}/license.xml`]: { ok: false, status: 404 },
      [`${origin}/robots.txt`]: { body: `License: ${attrUrl}` },
      [attrUrl]: { body: rsl(block(`${origin}/articles/*`)) }, // no server
    });

    await expect(
      obtainLicenseToken({ clientId: "d5", clientSecret: "s", resourceUrl: `${origin}/articles/x` })
    ).rejects.toThrow(/No mintable RSL license/);
  });

  it("throws a discovery error when origin fails and robots.txt has no License directive", async () => {
    const origin = "http://disc-nothing.com";
    mockRoutes({
      [`${origin}/license.xml`]: { ok: false, status: 404 },
      [`${origin}/robots.txt`]: { body: "User-agent: *\nDisallow: /" },
    });

    await expect(
      obtainLicenseToken({ clientId: "d6", clientSecret: "s", resourceUrl: `${origin}/articles/x` })
    ).rejects.toThrow(/No RSL license discoverable/);
  });

  it("caches the discovered license.xml by origin (no re-discovery on second call)", async () => {
    const origin = "http://disc-cache.com";
    const licUrl = "https://api.test/cache/license.xml";
    const mock = mockRoutes({
      [`${origin}/license.xml`]: { ok: false, status: 404 },
      [`${origin}/robots.txt`]: { body: `License: ${licUrl}` },
      [licUrl]: { body: rsl(block(`${origin}/articles/*`, "http://mint.test")) },
    });

    await obtainLicenseToken({ clientId: "d7", clientSecret: "s", resourceUrl: `${origin}/articles/x` });
    await obtainLicenseToken({ clientId: "d7", clientSecret: "s", resourceUrl: `${origin}/articles/y` });

    const robotsCalls = mock.mock.calls.filter(([u]) => u === `${origin}/robots.txt`);
    expect(robotsCalls).toHaveLength(1); // discovery ran once, then served from cache
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/customer.test.ts -t "license discovery"`
Expected: FAIL — origin 404 currently makes `fetchLicenseXml` throw `Failed to fetch license.xml ...`; robots.txt is never fetched, so the fallback/cache/error assertions fail.

- [ ] **Step 3: Replace `fetchLicenseXml` and add discovery helpers**

In `src/customer.ts`, replace the entire existing `fetchLicenseXml` function (currently ~lines 197-238) with the following:

```ts
function cacheLicenseXml(origin: string, xml: string): void {
  evictExpiredLicenseXml();
  licenseXmlCache.set(origin, { xml, fetchedAt: Math.floor(Date.now() / 1000) });
}

/** Fetch ${origin}/license.xml. Returns the XML, or null on any non-ok / network error. */
async function tryFetchOriginLicenseXml(
  origin: string,
  debug: boolean | undefined
): Promise<string | null> {
  const url = `${origin}/license.xml`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": SDK_USER_AGENT } });
    if (!response.ok) {
      if (debug) console.debug(`Origin ${url} returned ${response.status}; trying robots.txt discovery`);
      return null;
    }
    if (debug) console.debug("Fetched license.xml from", url);
    return await response.text();
  } catch (err) {
    if (debug) console.debug(`Origin ${url} fetch failed (${String(err)}); trying robots.txt discovery`);
    return null;
  }
}

/** True when the XML has a content block with a `server` that matches the resource. */
function licenseXmlHasMintableMatch(
  xml: string,
  resourceUrl: string,
  debug: boolean | undefined
): boolean {
  const mintable = parseContentElements(xml, debug).filter((b) => !!b.server);
  return findBestMatchingContent(mintable, resourceUrl, debug) !== null;
}

/**
 * Resolve a license.xml via robots.txt `License:` directives, origin having failed.
 * Follows directives in document order and returns the first XML with a mintable
 * block for the resource. Throws a discovery-specific error if none qualify.
 */
async function discoverLicenseXmlViaRobots(
  origin: string,
  resourceUrl: string,
  debug: boolean | undefined
): Promise<string> {
  const robotsUrl = `${origin}/robots.txt`;
  let directives: string[] = [];
  try {
    const response = await fetch(robotsUrl, { headers: { "User-Agent": SDK_USER_AGENT } });
    if (response.ok) {
      directives = parseRobotsLicenseDirectives(await response.text());
    } else if (debug) {
      console.debug(`robots.txt ${robotsUrl} returned ${response.status}`);
    }
  } catch (err) {
    if (debug) console.debug(`robots.txt ${robotsUrl} fetch failed (${String(err)})`);
  }

  if (directives.length === 0) {
    throw new Error(
      `No RSL license discoverable for ${origin}: origin /license.xml failed and robots.txt has no License directive`
    );
  }

  for (const licenseUrl of directives) {
    try {
      const response = await fetch(licenseUrl, { headers: { "User-Agent": SDK_USER_AGENT } });
      if (!response.ok) {
        if (debug) console.debug(`License directive ${licenseUrl} returned ${response.status}, skipping`);
        continue;
      }
      const xml = await response.text();
      if (licenseXmlHasMintableMatch(xml, resourceUrl, debug)) {
        if (debug) console.debug(`Resolved mintable license via robots.txt directive ${licenseUrl}`);
        return xml;
      }
      if (debug) console.debug(`License directive ${licenseUrl} has no mintable block for ${resourceUrl}, skipping`);
    } catch (err) {
      if (debug) console.debug(`License directive ${licenseUrl} fetch failed (${String(err)}), skipping`);
    }
  }

  throw new Error(`No mintable RSL license found via robots.txt for ${resourceUrl}`);
}

async function fetchLicenseXml(
  resourceUrl: string,
  debug: boolean | undefined
): Promise<string> {
  const origin = new URL(resourceUrl).origin;

  const cached = licenseXmlCache.get(origin);
  if (cached) {
    const now = Math.floor(Date.now() / 1000);
    if (now - cached.fetchedAt < LICENSE_XML_TTL_SECONDS) {
      if (debug) {
        console.debug(`Using cached license.xml for origin ${origin} (expires in ${LICENSE_XML_TTL_SECONDS - (now - cached.fetchedAt)}s)`);
      }
      return cached.xml;
    }
    if (debug) console.debug(`Cached license.xml for origin ${origin} expired, re-fetching`);
    licenseXmlCache.delete(origin);
  }

  const originXml = await tryFetchOriginLicenseXml(origin, debug);
  if (originXml !== null) {
    cacheLicenseXml(origin, originXml);
    return originXml;
  }

  const discovered = await discoverLicenseXmlViaRobots(origin, resourceUrl, debug);
  cacheLicenseXml(origin, discovered);
  return discovered;
}
```

- [ ] **Step 4: Run the discovery tests to verify they pass**

Run: `npm test -- tests/customer.test.ts -t "license discovery"`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full customer suite to verify no regressions**

Run: `npm test -- tests/customer.test.ts`
Expected: PASS — all pre-existing caching/matching tests still green (the origin-served path is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/customer.ts tests/customer.test.ts
git commit -m "feat(customer): fall back to robots.txt License discovery when origin lacks /license.xml"
```

---

## Notes / deliberate limitations

- **Serverless-usage licenses via robots.txt are out of scope (v1).** The origin-served path still supports the serverless-usage short-circuit in `obtainLicenseToken` unchanged. Discovery only returns a license that has a **mintable** block for the resource; a robots-referenced serverless-only license (e.g. free attribution) is treated as "non-mintable" and skipped. This matches the approved spec's mintable-focus and keeps the free-attribution semantics (external to Supertab) out of the token flow.
- **No robots-first mode, no Supertab registry coupling** — the SDK stays protocol-generic (RSL), resolving whatever the merchant published.
- **Python / PHP SDKs** share the same gap; mirroring is a follow-up, not part of this plan.
- **Cache-by-origin assumes one mintable license per merchant.** `fetchLicenseXml` caches the resolved license.xml (origin-served or robots-discovered) under the origin key, which is correct for v1 where a single mintable license covers the whole origin. If a merchant ever publishes multiple robots.txt `License:` directives that partition the resource space into distinct mintable licenses, origin-keyed caching would serve the wrong license for some paths — at that point the cache key should become the resolved license URL (or resource pattern) instead of the origin.

## Self-review

- **Spec coverage:** origin-first (Task 2 `fetchLicenseXml`) ✓; robots.txt parse ignoring UA grouping (Task 1) ✓; directive-order + first-mintable-wins (Task 2 helper + tests 3/4) ✓; caching by origin (Task 2 + test 7) ✓; three-way error taxonomy (Task 2 errors + tests 5/6; self-hosted "no matching content block" left untouched in `obtainLicenseToken`) ✓; non-goals recorded ✓.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `parseRobotsLicenseDirectives(string): string[]`, `licenseXmlHasMintableMatch(xml, resourceUrl, debug): boolean`, `tryFetchOriginLicenseXml(...): Promise<string|null>`, `discoverLicenseXmlViaRobots(...): Promise<string>`, `fetchLicenseXml(...): Promise<string>` — consistent across tasks and with existing `parseContentElements` / `findBestMatchingContent` signatures.
