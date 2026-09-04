import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";
import type { CloudFrontRequestEvent, CloudFrontRequestResult } from "aws-lambda";
import { MERCHANT_API_KEY } from "./config";

SupertabConnect.setBaseUrl("https://api-connect.sbx.supertab.co");
// Analytics goes to a separate ingest host; point it at the same environment as the API.
SupertabConnect.setAnalyticsBaseUrl("https://ingest-connect.sbx.supertab.co");

// One handler serves both deployment modes: the SDK auto-detects the trigger from the
// event. At viewer-request it processes every request (full analytics coverage); at
// origin-request it only processes requests the CloudFront Function stamped with
// x-license-auth.
export async function handler(
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequestResult> {
  return SupertabConnect.cloudfrontHandleRequests(event, {
    apiKey: MERCHANT_API_KEY,
    analyticsEnabled: true,
    debug: true,
    // Absolute budget, from handler entry, for the pre-response wait on background work
    // (analytics emit, event recording) — in-flight calls are aborted at the deadline.
    // Keep it well under the Lambda's configured timeout so a hung ingest/backend never
    // turns into an error for the viewer.
    backgroundWorkTimeoutMs: 2000,
  });
}
