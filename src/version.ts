declare const __SDK_VERSION__: string;

export const SDK_USER_AGENT = `supertab-connect-sdk-typescript/${typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "unknown"}`;
