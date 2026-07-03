declare const __SDK_VERSION__: string;

export const SDK_VERSION = typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "unknown";

export const SDK_USER_AGENT = `supertab-connect-sdk-typescript/${SDK_VERSION}`;
