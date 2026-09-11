import { EventPayload, FetchOptions } from "./types";
import { withFastlyBackend } from "./fastly-backend";
import { SDK_USER_AGENT } from "./version";

/**
 * Record a bot/license event on the Supertab Connect backend. Fail-open: never throws — a
 * failed call is swallowed (logged only under `debug`) so it cannot alter request handling.
 * @param params Event inputs.
 * @param params.apiKey Merchant API key sent as the bearer token.
 * @param params.baseUrl Supertab Connect API base URL; the event POSTs to `{baseUrl}/events`.
 * @param params.eventName Event name (e.g. `license_used`, or the verification failure reason).
 * @param params.properties Flat string properties attached to the event.
 * @param params.licenseId License id the event belongs to, when one was resolved.
 * @param params.debug Enable debug logging of failures (default: false).
 * @param params.signal Aborts the request when the caller's background-work deadline expires.
 * @returns A promise that resolves once the call settles, successfully or not.
 */
export async function recordEvent({
  apiKey,
  baseUrl,
  eventName,
  properties,
  licenseId,
  debug = false,
  signal,
}: {
  apiKey: string;
  baseUrl: string;
  eventName: string;
  properties: Record<string, string>;
  licenseId?: string;
  debug?: boolean;
  /** Aborts the request when the caller's background-work deadline expires. */
  signal?: AbortSignal;
}): Promise<void> {
  const payload: EventPayload = {
    event_name: eventName,
    license_id: licenseId,
    properties,
  };

  try {
    const options: FetchOptions = withFastlyBackend({
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": SDK_USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal,
    });
    const response = await fetch(`${baseUrl}/events`, options);

    if (!response.ok && debug) {
      console.error(`Failed to record event: ${response.status}`);
    }
  } catch (error) {
    if (debug) {
      console.error("Error recording event:", error);
    }
  }
}
