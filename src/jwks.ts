import { FASTLY_BACKEND, FetchOptions } from "./types";

const jwksCache = new Map<string, any>();

type JwksCacheKey = string;

type FetchJwksParams = {
  cacheKey: JwksCacheKey;
  url: string;
  debug: boolean;
  failureMessage: string;
  logLabel: string;
};

function buildFetchOptions(): FetchOptions {
  let options: FetchOptions = { method: "GET" };
  // @ts-ignore - backend is a Fastly-specific extension
  if (globalThis?.fastly) {
    options = { ...options, backend: FASTLY_BACKEND };
  }
  return options;
}

async function fetchAndCacheJwks({
  cacheKey,
  url,
  debug,
  failureMessage,
  logLabel,
}: FetchJwksParams): Promise<any> {
  if (!jwksCache.has(cacheKey)) {
    try {
      const response = await fetch(url, buildFetchOptions());

      if (!response.ok) {
        throw new Error(`${failureMessage}: ${response.status}`);
      }

      const jwksData = await response.json();
      jwksCache.set(cacheKey, jwksData);
    } catch (error) {
      if (debug) {
        console.error(logLabel, error);
      }
      throw error;
    }
  }

  return jwksCache.get(cacheKey);
}

export async function fetchPlatformJwks(
  baseUrl: string,
  debug: boolean
): Promise<any> {
  const jwksUrl = `${baseUrl}/.well-known/jwks.json/platform`;
  if (debug) {
    console.debug(`Fetching platform JWKS from URL: ${jwksUrl}`);
  }

  return fetchAndCacheJwks({
    cacheKey: "platform_jwks",
    url: jwksUrl,
    debug,
    failureMessage: "Failed to fetch platform JWKS",
    logLabel: "Error fetching platform JWKS:",
  });
}

export function clearJwksCache(): void {
  jwksCache.clear();
}
