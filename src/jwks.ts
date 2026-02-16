import type { JSONWebKeySet } from "jose";
import { FASTLY_BACKEND, FetchOptions } from "./types";

type JwksCacheEntry = { data: JSONWebKeySet; cachedAt: number };
const jwksCache = new Map<string, JwksCacheEntry>();
const JWKS_CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export class JwksKeyNotFoundError extends Error {
  constructor(kid: string | undefined) {
    super(`No matching platform key found: ${kid}`);
    this.name = "JwksKeyNotFoundError";
  }
}

type FetchJwksParams = {
  cacheKey: string;
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
}: FetchJwksParams): Promise<JSONWebKeySet> {
  const cached = jwksCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < JWKS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await fetch(url, buildFetchOptions());

    if (!response.ok) {
      throw new Error(`${failureMessage}: ${response.status}`);
    }

    const jwksData = await response.json() as JSONWebKeySet;
    jwksCache.set(cacheKey, { data: jwksData, cachedAt: Date.now() });
    return jwksData;
  } catch (error) {
    if (debug) {
      console.error(logLabel, error);
    }
    throw error;
  }
}

export async function fetchPlatformJwks(
  baseUrl: string,
  debug: boolean
): Promise<JSONWebKeySet> {
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
