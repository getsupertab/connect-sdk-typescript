import { BotVerdict } from "./analytics/types";

const KNOWN_BOT_UAS = [
  "chatgpt-user",
  "perplexitybot",
  "gptbot",
  "anthropic-ai",
  "ccbot",
  "claude-web",
  "claudebot",
  "cohere-ai",
  "youbot",
  "diffbot",
  "oai-searchbot",
  "meta-externalagent",
  "timpibot",
  "amazonbot",
  "bytespider",
  "perplexity-user",
  "googlebot",
  "bot",
  "curl",
  "wget",
];

/**
 * Heuristic bot classification using UA, headers, and Cloudflare bot score.
 *
 * Returns one of:
 *   - 'human'           — request looks like an interactive browser
 *   - 'unverified_bot'  — UA matches a known bot string (not cryptographically verified)
 *   - 'suspicious'      — headless indicators or suspicious header gaps
 *   - 'unknown'         — request has no UA / cannot be classified
 *
 * NOTE: 'verified_bot' is reserved for server-side verification (CAP, HTTP
 * Message Signatures) and is unreachable from this client-side detector.
 */
export function defaultBotDetector(request: Request): BotVerdict {
  const userAgent = request.headers.get("User-Agent") || "";
  const accept = request.headers.get("accept") || "";
  const secChUa = request.headers.get("sec-ch-ua");
  const acceptLanguage = request.headers.get("accept-language");
  const botScore = (request as any).cf?.botManagement?.score;

  if (!userAgent) {
    return "unknown";
  }

  const lowerCaseUserAgent = userAgent.toLowerCase();
  const botUaMatch = KNOWN_BOT_UAS.some((bot) => lowerCaseUserAgent.includes(bot));
  if (botUaMatch) {
    return "unverified_bot";
  }

  const isHeadless =
    lowerCaseUserAgent.includes("headless") || lowerCaseUserAgent.includes("puppeteer");
  const isBrowserUa =
    lowerCaseUserAgent.includes("safari") || lowerCaseUserAgent.includes("mozilla");

  // Safari/Mozilla without sec-ch-ua is plausibly a real browser (some Safari
  // builds omit the header). Don't flag those.
  if (isBrowserUa && !isHeadless && !secChUa) {
    return "human";
  }

  if (isHeadless) {
    return "suspicious";
  }

  const lowBotScore = typeof botScore === "number" && botScore < 30;
  if (lowBotScore) {
    return "suspicious";
  }

  if (!accept || !acceptLanguage) {
    return "suspicious";
  }

  if (!secChUa) {
    return "suspicious";
  }

  return "human";
}
