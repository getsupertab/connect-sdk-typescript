import { describe, it, expect } from "vitest";
import { toEventProperties } from "../src/headers";

describe("toEventProperties", () => {
  it("lowercases keys and applies the h_ prefix", () => {
    const result = toEventProperties({
      "Accept-Language": "en-US",
      "X-Custom": "value",
    });
    expect(result).toEqual({
      "h_accept-language": "en-US",
      "h_x-custom": "value",
    });
  });

  it("drops user-agent since it is already captured as properties.user_agent", () => {
    const result = toEventProperties({
      "User-Agent": "GPTBot/1.0",
      "Accept": "text/html",
    });
    expect(result).toEqual({ "h_accept": "text/html" });
  });

  it("drops credential and SDK-internal headers regardless of casing", () => {
    const result = toEventProperties({
      Authorization: "License abc123",
      COOKIE: "session=xyz",
      "Set-Cookie": "foo=bar",
      "Proxy-Authorization": "Basic xxx",
      "X-API-Key": "sk_123",
      "X-Amz-Security-Token": "amz-token",
      "X-License-Auth": "cf-request-id",
      Accept: "application/json",
    });
    expect(result).toEqual({ h_accept: "application/json" });
  });

  it("includes client IP headers for bot traffic analytics", () => {
    const result = toEventProperties({
      "X-Forwarded-For": "203.0.113.1",
      "X-Real-IP": "203.0.113.2",
      "CF-Connecting-IP": "203.0.113.3",
      "True-Client-IP": "203.0.113.4",
    });
    expect(result).toEqual({
      "h_x-forwarded-for": "203.0.113.1",
      "h_x-real-ip": "203.0.113.2",
      "h_cf-connecting-ip": "203.0.113.3",
      "h_true-client-ip": "203.0.113.4",
    });
  });

  it("returns an empty object for empty input", () => {
    expect(toEventProperties({})).toEqual({});
  });

  it("preserves header values exactly", () => {
    const result = toEventProperties({ "X-Custom": "  value with spaces  " });
    expect(result["h_x-custom"]).toBe("  value with spaces  ");
  });
});
