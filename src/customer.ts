import { loadKeyImport, loadJwtSign, loadDecodeJwt } from "./jose";
import { scorePathPattern } from "./url-pattern";
import { SDK_USER_AGENT } from "./version";

type SupportedAlg = "RS256" | "ES256";

type CachedToken = { token: string; exp: number };

// In-memory cache for license tokens, keyed by "clientId:server:urlPattern"
const licenseTokenCache = new Map<string, CachedToken>();

type CachedLicenseXml = { xml: string; fetchedAt: number };
const LICENSE_XML_TTL_SECONDS = 15 * 60; // 15 minutes

// In-memory cache for license.xml content, keyed by origin (e.g. "https://example.com")
const licenseXmlCache = new Map<string, CachedLicenseXml>();

function evictExpiredLicenseXml(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [origin, entry] of licenseXmlCache) {
    if (now - entry.fetchedAt >= LICENSE_XML_TTL_SECONDS) {
      licenseXmlCache.delete(origin);
    }
  }
}

function getCachedToken(
  cacheKey: string,
  debug?: boolean
): string | null {
  const cached = licenseTokenCache.get(cacheKey);
  if (!cached) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cached.exp > now + 30) {
    if (debug) {
      console.debug(
        `Using cached license token (expires in ${cached.exp - now}s)`
      );
    }
    return cached.token;
  }

  if (debug) {
    console.debug("Cached license token expired or expiring soon, refreshing");
  }
  licenseTokenCache.delete(cacheKey);
  return null;
}

type GenerateLicenseTokenParams = {
  clientId: string;
  kid: string;
  privateKeyPem: string;
  tokenEndpoint: string;
  resourceUrl: string;
  licenseXml: string;
  debug?: boolean;
};

export enum UsageType {
  ALL = "all",
  SEARCH = "search",
  AI_ALL = "ai-all",
  AI_TRAIN = "ai-train",
  AI_INDEX = "ai-index",
  AI_INPUT = "ai-input",
}

type ObtainLicenseTokenParams = {
  clientId: string;
  clientSecret: string;
  resourceUrl: string;
  usage?: UsageType;
  debug?: boolean;
};

type ContentBlock = {
  urlPattern: string;
  licenseXml: string;
  server?: string;
};

async function retrieveLicenseToken(
    tokenEndpoint: string,
    requestOptions: RequestInit,
    debug: boolean | undefined
) {
  try {
    const response = await fetch(tokenEndpoint, requestOptions);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const errorMessage = `Failed to obtain license token: ${
        response.status
      } ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`;
      throw new Error(errorMessage);
    }

    let data: { access_token?: string };
    try {
      data = await response.json() as { access_token?: string };
    } catch (parseError) {
      if (debug) {
        console.error(
          "Failed to parse license token response as JSON:",
          parseError
        );
      }
      throw new Error("Failed to parse license token response as JSON");
    }

    if (!data?.access_token) {
      throw new Error("License token response missing access_token");
    }

    return data.access_token;
  } catch (error) {
    if (debug) {
      console.error("Error generating license token:", error);
    }
    throw error;
  }
}

async function importKeyForAlgs(
  privateKeyPem: string,
  debug: boolean | undefined
): Promise<{ key: CryptoKey; alg: SupportedAlg }> {
  const { importPKCS8 } = await loadKeyImport();
  const supportedAlgs: SupportedAlg[] = ["ES256", "RS256"];

  for (const algorithm of supportedAlgs) {
    try {
      const key = await importPKCS8(privateKeyPem, algorithm);
      return { key, alg: algorithm };
    } catch (importError) {
      if (debug) {
        console.debug(
          `Private key did not import using ${algorithm}, retrying...`,
          importError
        );
      }
    }
  }

  throw new Error(
    "Unsupported private key format. Expected RSA or P-256 EC private key."
  );
}

// Temporarily not exporting this function to reflect only client credentials flow being supported
async function generateLicenseToken({
  clientId,
  kid,
  privateKeyPem,
  tokenEndpoint,
  resourceUrl,
  licenseXml,
  debug,
}: GenerateLicenseTokenParams): Promise<string> {
  const { SignJWT } = await loadJwtSign();
  const { key, alg } = await importKeyForAlgs(privateKeyPem, debug);
  const now = Math.floor(Date.now() / 1000);

  const clientAssertion = await new SignJWT({})
    .setProtectedHeader({ alg, kid })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setAudience(tokenEndpoint)
    .sign(key);

  const payload = new URLSearchParams({
    grant_type: "rsl",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: clientAssertion,
    license: licenseXml,
    resource: resourceUrl,
  });

  const requestOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": SDK_USER_AGENT,
    },
    body: payload.toString(),
  };

  return retrieveLicenseToken(tokenEndpoint, requestOptions, debug);
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
    if (debug) {
      console.debug(`Cached license.xml for origin ${origin} expired, re-fetching`);
    }
    licenseXmlCache.delete(origin);
  }

  const licenseXmlUrl = `${origin}/license.xml`;
  const response = await fetch(licenseXmlUrl, {
    headers: { "User-Agent": SDK_USER_AGENT },
  });
  if (!response.ok) {
    if (debug) {
      console.error(`Failed to fetch license.xml from ${licenseXmlUrl}: ${response.status}`);
    }
    throw new Error(
      `Failed to fetch license.xml from ${licenseXmlUrl}: ${response.status}`
    );
  }

  const xml = await response.text();
  if (debug) {
    console.debug("Fetched license.xml from", licenseXmlUrl);
  }
  evictExpiredLicenseXml();
  licenseXmlCache.set(origin, { xml, fetchedAt: Math.floor(Date.now() / 1000) });
  return xml;
}

function parseContentElements(xml: string, debug?: boolean): ContentBlock[] {
  const contentBlocks: ContentBlock[] = [];
  const contentRegex = /<content\s([^>]*)>([\s\S]*?)<\/content>/gi;
  const urlRegex = /url\s*=\s*"([^"]*)"/i;
  const serverRegex = /server\s*=\s*"([^"]*)"/i;
  const licenseRegex = /<license[^>]*>[\s\S]*?<\/license>/i;

  let elementCount = 0;
  let match;
  while ((match = contentRegex.exec(xml)) !== null) {
    elementCount++;
    const attrs = match[1];
    const body = match[2];
    const urlMatch = attrs.match(urlRegex);
    const serverMatch = attrs.match(serverRegex);
    const licenseMatch = body.match(licenseRegex);

    if (urlMatch && licenseMatch) {
      contentBlocks.push({
        urlPattern: urlMatch[1],
        server: serverMatch?.[1],
        licenseXml: licenseMatch[0],
      });
    } else if (debug) {
      const missing = [
        !urlMatch && "url",
        !licenseMatch && "<license>",
      ].filter(Boolean).join(", ");
      console.debug(`Skipping <content> element #${elementCount}: missing ${missing}`);
    }
  }

  if (debug) {
    console.debug(`Found ${elementCount} <content> element(s), ${contentBlocks.length} valid`);
  }

  return contentBlocks;
}

/**
 * Check if <license> section permits the chosen usage type without prohibiting it
 * @param licenseXml
 * @param usage
 */
function licensePermitsUsage(
  licenseXml: string,
  usage: UsageType
): boolean {
  const permitsRegex = /<permits\b[^>]*type\s*=\s*"usage"[^>]*>([\s\S]*?)<\/permits>/gi;
  const prohibitsRegex = /<prohibits\b[^>]*type\s*=\s*"usage"[^>]*>([\s\S]*?)<\/prohibits>/gi;

  let match: RegExpExecArray | null;

  // Check for <prohibits> first - it takes precedence
  while ((match = prohibitsRegex.exec(licenseXml)) !== null) {
    const prohibitedUsages = match[1]
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (
      prohibitedUsages.includes(UsageType.ALL) ||
      prohibitedUsages.includes(usage)
    ) {
      return false;
    }
  }

  // Now we can safely look for <permits>
  while ((match = permitsRegex.exec(licenseXml)) !== null) {
    const permittedUsages = match[1]
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (
      permittedUsages.includes(UsageType.ALL) ||
      permittedUsages.includes(usage)
    ) {
      return true;
    }
  }

  return false;
}

function findBestMatchingContent(
  contentBlocks: ContentBlock[],
  resourceUrl: string,
  debug?: boolean
): ContentBlock | null {
  const parsed = new URL(resourceUrl);
  const host = parsed.host;
  const path = parsed.pathname;

  if (debug) {
    console.debug(`Matching resource URL: ${resourceUrl} (host=${host}, path=${path})`);
  }

  let bestMatch: ContentBlock | null = null;
  let bestSpecificity = -1;

  for (const block of contentBlocks) {
    let patternPath: string;
    const isPathOnly = block.urlPattern.startsWith("/");

    if (isPathOnly) {
      patternPath = block.urlPattern;
    } else {
      let patternUrl: URL;
      try {
        patternUrl = new URL(block.urlPattern);
      } catch {
        if (debug) {
          console.debug(`Skipping block with invalid URL pattern: ${block.urlPattern}`);
        }
        continue;
      }

      if (patternUrl.host !== host) {
        if (debug) {
          console.debug(`Skipping block: host mismatch (pattern=${patternUrl.host}, resource=${host})`);
        }
        continue;
      }

      patternPath = patternUrl.pathname;
    }

    // Exact match — highest priority, return immediately
    if (patternPath === path) {
      if (debug) {
        console.debug(`Exact match found: ${block.urlPattern}`);
      }
      return block;
    }

    // Pattern match (wildcards, prefix, anchored)
    const specificity = scorePathPattern(patternPath, path);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestMatch = block;
    }
  }

  if (debug) {
    if (bestMatch) {
      console.debug(`Wildcard match found: ${bestMatch.urlPattern} (specificity=${bestSpecificity})`);
    } else {
      console.debug(`No matching content block found for ${resourceUrl}`);
    }
  }

  return bestMatch;
}

export { parseContentElements, findBestMatchingContent };
export type { ContentBlock };

/**
 * Find serverless content with <permits> section for the selected usage type that matches with the requested resource.
 * @param contentBlocks Parsed content blocks of the processed License XML
 * @param resourceUrl Requested resource
 * @param usage One of usage types as defined in RSL Specification
 * @param debug Enables debug printouts if true
 */
function findServerlessUsageContent(
  contentBlocks: ContentBlock[],
  resourceUrl: string,
  usage: UsageType,
  debug?: boolean
): ContentBlock | null {
  const matchingUsageBlocks = contentBlocks.filter(
    (block) => !block.server && licensePermitsUsage(block.licenseXml, usage)
  );

  return findBestMatchingContent(matchingUsageBlocks, resourceUrl, debug);
}

export async function obtainLicenseToken({
  clientId,
  clientSecret,
  resourceUrl,
  usage,
  debug,
}: ObtainLicenseTokenParams): Promise<string | undefined> {
  const xml = await fetchLicenseXml(resourceUrl, debug);
  if (debug) {
    console.debug(`Fetched license.xml (${xml.length} chars)`);
  }
  const contentBlocks = parseContentElements(xml, debug);

  if (contentBlocks.length === 0) {
    if (debug) {
      console.error("No valid <content> elements with <license> found in license.xml");
    }
    throw new Error(
      "No valid <content> elements with <license> found in license.xml"
    );
  }

  if (usage) {
    const serverlessUsageContent = findServerlessUsageContent(
      contentBlocks,
      resourceUrl,
      usage,
      debug
    );

    if (serverlessUsageContent) {
      if (debug) {
        console.debug("Matched serverless content to usage and resource URL combination, skipping license token request. ");
        console.debug("URL: " + resourceUrl + ", Usage: " + usage);
      }
      return undefined;
    }
  }

  const tokenContentBlocks = contentBlocks.filter((block) => !!block.server);
  const matchedContent = findBestMatchingContent(tokenContentBlocks, resourceUrl, debug);
  if (!matchedContent) {
    if (debug) {
      const patterns = tokenContentBlocks.map(b => b.urlPattern).join(", ");
      console.error(`No <content> element matches resource URL: ${resourceUrl}. Available patterns: ${patterns}`);
    }
    throw new Error(
      `No <content> element in license.xml matches resource URL: ${resourceUrl}`
    );
  }

  if (debug) {
    console.debug("Matched content block for resource URL:", resourceUrl);
    console.debug("Using license XML:", matchedContent.licenseXml);
  }

  // Cache tokens by server + urlPattern so path-only patterns (e.g. "/articles/*")
  // on different origins/servers don't collide with each other.
  const cacheKey = `${clientId}:${matchedContent.server}:${matchedContent.urlPattern}`;
  const cached = getCachedToken(cacheKey, debug);
  if (cached) return cached;

  const tokenEndpoint = matchedContent.server + '/token';
  if (debug) {
    console.debug(`Requesting license token from ${tokenEndpoint}`);
  }

  const payload = new URLSearchParams({
    grant_type: "client_credentials",
    license: matchedContent.licenseXml,
    resource: matchedContent.urlPattern,
  });

  const requestOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "User-Agent": SDK_USER_AGENT,
    },
    body: payload.toString(),
  };

  const token = await retrieveLicenseToken(tokenEndpoint, requestOptions, debug);

  try {
    const { decodeJwt } = await loadDecodeJwt();
    const claims = decodeJwt(token);
    if (claims.exp) {
      licenseTokenCache.set(cacheKey, { token, exp: claims.exp });
    }
  } catch {
    if (debug) {
      console.debug("Failed to decode token for caching, skipping cache");
    }
  }

  return token;
}

export type { ObtainLicenseTokenParams };
