const DENIED_HEADERS = new Set([
  // Credentials
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-amz-security-token",
  // Already captured as properties.user_agent — avoid duplication
  "user-agent",
  // SDK-internal plumbing (not useful as analytics signal)
  "x-license-auth",
]);

/**
 * Transform a raw headers record into event properties: lowercase keys,
 * drop sensitive headers, and apply an `h_` prefix. Called from
 * verifyAndRecordEvent so both automatic and manual paths enforce the
 * same rules.
 */
export function toEventProperties(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!DENIED_HEADERS.has(lowerKey)) {
      result[`h_${lowerKey}`] = value;
    }
  }
  return result;
}
