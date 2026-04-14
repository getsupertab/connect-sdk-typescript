import { describe, it, expect } from "vitest";
import { collectRequestHeaders, filterHeaders, prefixHeadersForEvent } from "../src/headers";

describe("filterHeaders", () => {
  it("lowercases all keys", () => {
    const result = filterHeaders({
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US",
      "X-Custom": "value",
    });
    expect(result).toEqual({
      "user-agent": "Mozilla/5.0",
      "accept-language": "en-US",
      "x-custom": "value",
    });
  });

  it("drops credential headers regardless of casing", () => {
    const result = filterHeaders({
      Authorization: "License abc123",
      COOKIE: "session=xyz",
      "Set-Cookie": "foo=bar",
      "Proxy-Authorization": "Basic xxx",
      "X-API-Key": "sk_123",
      "X-Amz-Security-Token": "amz-token",
      Accept: "application/json",
    });
    expect(result).toEqual({ accept: "application/json" });
  });

  it("drops client IP headers to avoid PII leakage", () => {
    const result = filterHeaders({
      "X-Forwarded-For": "203.0.113.1",
      "X-Real-IP": "203.0.113.1",
      "CF-Connecting-IP": "203.0.113.1",
      "True-Client-IP": "203.0.113.1",
      "User-Agent": "GPTBot/1.0",
    });
    expect(result).toEqual({ "user-agent": "GPTBot/1.0" });
  });

  it("returns an empty object for empty input", () => {
    expect(filterHeaders({})).toEqual({});
  });

  it("preserves header values exactly", () => {
    const result = filterHeaders({ "X-Custom": "  value with spaces  " });
    expect(result["x-custom"]).toBe("  value with spaces  ");
  });
});

describe("prefixHeadersForEvent", () => {
  it("prefixes all keys with h_", () => {
    const result = prefixHeadersForEvent({
      "user-agent": "GPTBot/1.0",
      accept: "text/html",
    });
    expect(result).toEqual({
      "h_user-agent": "GPTBot/1.0",
      h_accept: "text/html",
    });
  });

  it("returns an empty object for empty input", () => {
    expect(prefixHeadersForEvent({})).toEqual({});
  });
});

describe("collectRequestHeaders", () => {
  it("collects headers from a Request, lowercased and filtered", () => {
    const request = new Request("https://example.com", {
      headers: {
        "User-Agent": "GPTBot/1.0",
        Authorization: "License secret",
        Accept: "text/html",
        Cookie: "session=xyz",
      },
    });
    const result = collectRequestHeaders(request);
    expect(result).not.toHaveProperty("authorization");
    expect(result).not.toHaveProperty("cookie");
    expect(result["user-agent"]).toBe("GPTBot/1.0");
    expect(result["accept"]).toBe("text/html");
  });
});
