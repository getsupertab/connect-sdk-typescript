// index.ts - FIRST LINE
import { webcrypto } from "node:crypto";
globalThis.crypto = webcrypto as any;

import { SupertabConnect } from "@getsupertab/supertab-connect-sdk";
import type {
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";
import { MERCHANT_SYSTEM_URN, MERCHANT_API_KEY } from "./config";

// Initialize Supertab SDK
const supertab = new SupertabConnect({
  apiKey: MERCHANT_API_KEY,
  merchantSystemUrn: MERCHANT_SYSTEM_URN,
});

// Uncomment to use a different base URL (for testing/development)
SupertabConnect.setBaseUrl("https://api-connect.sbx.supertab.co");

export async function handler(
  event: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> {
  console.log("Node version:", process.version);
  console.log("crypto available:", typeof globalThis.crypto);

  const cfRequest = event.Records[0].cf.request;

  // Convert CloudFront request to Web API Request
  const url = `https://${cfRequest.headers.host[0].value}${cfRequest.uri}${cfRequest.querystring ? "?" + cfRequest.querystring : ""}`;

  const headers = new Headers();
  Object.entries(cfRequest.headers).forEach(([key, values]) => {
    values.forEach(({ value }) => headers.append(key, value));
  });

  const webRequest = new Request(url, {
    method: cfRequest.method,
    headers: headers,
  });

  // Bot detection: curl requires token verification (returns true)
  // Non-curl bypasses verification (returns false)
  const botDetectionHandler = (request: Request) => {
    const userAgent = request.headers.get("User-Agent") || "";
    console.log("User-Agent:", userAgent);
    const isCurl = userAgent.toLowerCase().includes("curl");
    console.log("Is curl:", isCurl, "- Will verify token:", isCurl);
    console.log("-----");
    // Return true for curl (verify token), false for non-curl (bypass)
    return isCurl;
  };

  // Call Supertab SDK with the Web API Request
  const response = await supertab.handleRequest(
    webRequest,
    botDetectionHandler,
  );

  // Convert Response to CloudFront format if unauthorized
  if (response.status === 401 || response.status === 402) {
    const responseHeaders: Record<
      string,
      Array<{ key: string; value: string }>
    > = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = [{ key, value }];
    });

    return {
      status: response.status.toString(),
      statusDescription:
        response.statusText ||
        (response.status === 401 ? "Unauthorized" : "Payment Required"),
      headers: responseHeaders,
      body: await response.text(),
    };
  }

  // Allow request to continue to origin
  return cfRequest;
}
