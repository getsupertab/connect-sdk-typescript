import { describe, it, expect } from "vitest";
import { collectRequestHeaders, filterHeaders } from "../src/headers";

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

  it("drops denied headers regardless of casing", () => {
    const result = filterHeaders({
      Authorization: "License abc123",
      COOKIE: "session=xyz",
      "Set-Cookie": "foo=bar",
      "Proxy-Authorization": "Basic xxx",
      Accept: "application/json",
    });
    expect(result).toEqual({ accept: "application/json" });
  });

  it("returns an empty object for empty input", () => {
    expect(filterHeaders({})).toEqual({});
  });

  it("preserves header values exactly", () => {
    const result = filterHeaders({ "X-Custom": "  value with spaces  " });
    expect(result["x-custom"]).toBe("  value with spaces  ");
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
