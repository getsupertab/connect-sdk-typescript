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

export async function handler(
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequestResult> {
  return SupertabConnect.cloudfrontHandleRequests(event, {
    apiKey: MERCHANT_API_KEY,
    analyticsEnabled: true,
    debug: true,
  });
}
