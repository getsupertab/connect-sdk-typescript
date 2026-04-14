const DENIED_HEADERS = new Set([
  // Credentials
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-amz-security-token",
  // Client IP / PII
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
]);

/**
 * Normalize a headers record: lowercase all keys and drop sensitive headers.
 * Used as the single source of truth for header filtering so both automatic
 * (handleRequest) and manual (verifyAndRecord) paths enforce the same rules.
 */
export function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!DENIED_HEADERS.has(lowerKey)) {
      filtered[lowerKey] = value;
    }
  }
  return filtered;
}

export function collectRequestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return filterHeaders(headers);
}

/**
 * Apply the `h_` prefix to header keys for inclusion in event properties.
 * Kept as an explicitly typed helper so `properties` stays `Record<string, string>`
 * (Object.fromEntries widens to `any` in TS).
 */
export function prefixHeadersForEvent(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[`h_${key}`] = value;
  }
  return result;
}
