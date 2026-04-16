/// <reference types="@fastly/js-compute" />
import { SecretStore } from "fastly:secret-store";
import {
  SupertabConnect,
  defaultBotDetector,
  EnforcementMode,
  CONFIG,
} from "./config.js";


SupertabConnect.setBaseUrl(CONFIG.BASE_URL);

// The entry point for the request handler.
addEventListener("fetch", (event) =>
  event.respondWith((async () => {
    let MERCHANT_SYSTEM_URN, MERCHANT_API_KEY;

    try {
      const configDict = new SecretStore("demo");
      MERCHANT_SYSTEM_URN = await configDict.get("MERCHANT_SYSTEM_URN");
      MERCHANT_API_KEY = await configDict.get("MERCHANT_API_KEY");
    } catch (e) {
      // Dictionary not available, fall back to hardcoded config.js
      MERCHANT_SYSTEM_URN = CONFIG.MERCHANT_SYSTEM_URN;
      MERCHANT_API_KEY = CONFIG.MERCHANT_API_KEY;
    }

    return SupertabConnect.fastlyHandleRequests(
      event.request,
      MERCHANT_API_KEY,
      "origin",
      {
        enableRSL: true,
        merchantSystemUrn: MERCHANT_SYSTEM_URN,
        // botDetector: defaultBotDetector,
        // enforcement: EnforcementMode.STRICT,
      }
    )
  })())
);
