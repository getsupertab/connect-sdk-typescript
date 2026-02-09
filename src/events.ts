import { EventPayload, FASTLY_BACKEND } from "./types";

export async function recordEvent({
  apiKey,
  merchantSystemUrn,
  baseUrl,
  eventName,
  properties,
  licenseId,
}: {
  apiKey: string;
  merchantSystemUrn: string;
  baseUrl: string;
  eventName: string;
  properties: Record<string, any>;
  licenseId?: string;
}): Promise<void> {
  const payload: EventPayload = {
    event_name: eventName,
    merchant_system_urn: merchantSystemUrn,
    license_id: licenseId,
    properties,
  };

  try {
    let options: any = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    };
    // @ts-ignore
    if (globalThis?.fastly) {
      options = { ...options, backend: FASTLY_BACKEND };
    }
    const response = await fetch(`${baseUrl}/events`, options);

    if (!response.ok) {
      console.log(`Failed to record event: ${response.status}`);
    }
  } catch (error) {
    console.log("Error recording event:", error);
  }
}
