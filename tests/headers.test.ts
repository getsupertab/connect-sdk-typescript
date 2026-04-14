import { describe, it, expect } from "vitest";
import { toEventProperties } from "../src/headers";

describe("toEventProperties", () => {
  it("lowercases keys and applies the h_ prefix", () => {
    const result = toEventProperties({
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US",
      "X-Custom": "value",
    });
    expect(result).toEqual({
      "h_user-agent": "Mozilla/5.0",
      "h_accept-language": "en-US",
      "h_x-custom": "value",
    });
  });

  it("drops credential headers regardless of casing", () => {
    const result = toEventProperties({
      Authorization: "License abc123",
      COOKIE: "session=xyz",
      "Set-Cookie": "foo=bar",
      "Proxy-Authorization": "Basic xxx",
      "X-API-Key": "sk_123",
      "X-Amz-Security-Token": "amz-token",
      Accept: "application/json",
    });
    expect(result).toEqual({ h_accept: "application/json" });
  });

  it("drops client IP headers to avoid PII leakage", () => {
    const result = toEventProperties({
      "X-Forwarded-For": "203.0.113.1",
      "X-Real-IP": "203.0.113.1",
      "CF-Connecting-IP": "203.0.113.1",
      "True-Client-IP": "203.0.113.1",
      "User-Agent": "GPTBot/1.0",
    });
    expect(result).toEqual({ "h_user-agent": "GPTBot/1.0" });
  });

  it("returns an empty object for empty input", () => {
    expect(toEventProperties({})).toEqual({});
  });

  it("preserves header values exactly", () => {
    const result = toEventProperties({ "X-Custom": "  value with spaces  " });
    expect(result["h_x-custom"]).toBe("  value with spaces  ");
  });
});
