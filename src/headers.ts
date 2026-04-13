const DENIED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

export function collectRequestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!DENIED_HEADERS.has(key.toLowerCase())) {
      headers[key.toLowerCase()] = value;
    }
  });
  return headers;
}
