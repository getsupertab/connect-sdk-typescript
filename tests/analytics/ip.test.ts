import { describe, it, expect } from "vitest";
import { normalizeClientIp } from "../../src/analytics/ip";

describe("normalizeClientIp", () => {
  it("maps an IPv4 address to its IPv6-mapped form", () => {
    expect(normalizeClientIp("1.2.3.4")).toBe("::ffff:1.2.3.4");
    expect(normalizeClientIp("192.0.2.1")).toBe("::ffff:192.0.2.1");
  });

  it("trims surrounding whitespace before mapping IPv4", () => {
    expect(normalizeClientIp("  1.2.3.4  ")).toBe("::ffff:1.2.3.4");
  });

  it("passes IPv6 addresses through unchanged", () => {
    expect(normalizeClientIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeClientIp("::1")).toBe("::1");
  });

  it("returns :: for undefined", () => {
    expect(normalizeClientIp(undefined)).toBe("::");
  });

  it("returns :: for null", () => {
    expect(normalizeClientIp(null)).toBe("::");
  });

  it("returns :: for an empty string", () => {
    expect(normalizeClientIp("")).toBe("::");
    expect(normalizeClientIp("   ")).toBe("::");
  });

  it("returns :: for an unrecognized value", () => {
    expect(normalizeClientIp("not-an-ip")).toBe("::");
  });
});
