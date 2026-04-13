import { EventPayload, FASTLY_BACKEND, FetchOptions } from "./types";
import { SDK_USER_AGENT } from "./version";

export async function recordEvent({
  apiKey,
  baseUrl,
  eventName,
  properties,
  licenseId,
  debug = false,
}: {
  apiKey: string;
  baseUrl: string;
  eventName: string;
  properties: Record<string, string>;
  licenseId?: string;
  debug?: boolean;
}): Promise<void> {
  const payload: EventPayload = {
    event_name: eventName,
    license_id: licenseId,
    properties,
  };

  try {
    let options: FetchOptions = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": SDK_USER_AGENT,
      },
      body: JSON.stringify(payload),
    };
    if (globalThis.fastly) {
      options = { ...options, backend: FASTLY_BACKEND };
    }
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
