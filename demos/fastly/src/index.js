/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import { SupertabConnect, CONFIG } from "./config.js";

let MERCHANT_SYSTEM_URN, MERCHANT_API_KEY;

try {
  const configDict = new SecretStore("demo");
  MERCHANT_SYSTEM_URN = configDict.get("MERCHANT_SYSTEM_URN");
  MERCHANT_API_KEY = configDict.get("MERCHANT_API_KEY");
} catch (e) {
  // Dictionary not available, fall back to hardcoded config.js
  MERCHANT_SYSTEM_URN = CONFIG.MERCHANT_SYSTEM_URN;
  MERCHANT_API_KEY = CONFIG.MERCHANT_API_KEY;
}

SupertabConnect.setBaseUrl(CONFIG.BASE_URL);

// The entry point for the request handler.
addEventListener("fetch", (event) =>
  event.respondWith(
    SupertabConnect.fastlyHandleRequests(
      event.request,
      MERCHANT_SYSTEM_URN,
      MERCHANT_API_KEY,
      true
    )
  )
);
