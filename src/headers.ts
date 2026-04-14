const DENIED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
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
