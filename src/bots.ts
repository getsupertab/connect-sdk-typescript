/**
 * Default bot detection logic using multiple signals.
 * Checks User-Agent patterns, headless browser indicators, missing headers, and Cloudflare bot scores.
 * @param request The incoming request to analyze
 * @returns true if the request appears to be from a bot, false otherwise
 */
export function defaultBotDetector(request: Request): boolean {
  const userAgent = request.headers.get("User-Agent") || "";
  const accept = request.headers.get("accept") || "";
  const secChUa = request.headers.get("sec-ch-ua");
  const acceptLanguage = request.headers.get("accept-language");
  const botScore = (request as any).cf?.botManagement?.score;

  const botList = [
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
  // 1. Basic substring check from known list
  const lowerCaseUserAgent = userAgent.toLowerCase();
  const botUaMatch = botList.some((bot) => lowerCaseUserAgent.includes(bot));

  // 2. Headless browser detection
  const headlessIndicators =
    lowerCaseUserAgent.includes("headless") ||
    lowerCaseUserAgent.includes("puppeteer") ||
    !secChUa;

  const isBrowserMissingSecChUa =
    !lowerCaseUserAgent.includes("headless") &&
    !lowerCaseUserAgent.includes("puppeteer") &&
    !secChUa;

  // 3. Suspicious header gaps — many bots omit these
  const missingHeaders = !accept || !acceptLanguage;

  // 4. Cloudflare bot score check (if available)
  const lowBotScore = typeof botScore === "number" && botScore < 30;

  // Safari and Mozilla special case
  if (
    lowerCaseUserAgent.includes("safari") ||
    lowerCaseUserAgent.includes("mozilla")
  ) {
    // Safari is not a bot, but it may be headless
    if (headlessIndicators && isBrowserMissingSecChUa) {
      return false; // Likely not a bot, but missing a Sec-CH-UA header
    }
  }

  // Final decision
  return botUaMatch || headlessIndicators || missingHeaders || lowBotScore;
}
