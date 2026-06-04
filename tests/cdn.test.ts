import { describe, it, expect } from "vitest";
import { parseAsn } from "../src/cdn";

describe("parseAsn", () => {
  it("parses a plain numeric ASN", () => {
    expect(parseAsn("13335")).toBe(13335);
  });

  it("parses an AS-prefixed ASN", () => {
    expect(parseAsn("AS13335")).toBe(13335);
  });

  it("returns null for zero", () => {
    expect(parseAsn("0")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseAsn("")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseAsn("abc")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseAsn(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseAsn(undefined)).toBeNull();
  });
});
