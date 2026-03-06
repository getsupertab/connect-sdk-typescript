import { describe, it, expect } from "vitest";
import { matchPathPattern } from "../src/url-pattern";

describe("matchPathPattern", () => {
  describe("prefix matching without wildcards", () => {
    it("matches exact path", () => {
      expect(matchPathPattern("/content", "/content")).toBe(8);
    });

    it("matches at segment boundary", () => {
      expect(matchPathPattern("/content", "/content/article")).toBe(8);
    });

    it("does not match non-segment prefix", () => {
      expect(matchPathPattern("/content", "/content-other")).toBe(-1);
    });

    it("root prefix matches any path", () => {
      expect(matchPathPattern("/", "/anything")).toBe(1);
    });
  });

  describe("trailing wildcard", () => {
    it("matches sub-path", () => {
      expect(matchPathPattern("/content/*", "/content/article")).toBe(9);
    });

    it("matches across segments", () => {
      expect(matchPathPattern("/content/*", "/content/a/b")).toBe(9);
    });

    it("does not match unrelated path", () => {
      expect(matchPathPattern("/content/*", "/other")).toBe(-1);
    });
  });

  describe("mid-path wildcard", () => {
    it("matches single segment", () => {
      expect(matchPathPattern("/content/*/article", "/content/news/article")).toBe(17);
    });

    it("matches multiple segments", () => {
      expect(matchPathPattern("/content/*/article", "/content/a/b/article")).toBe(17);
    });

    it("does not match when suffix differs", () => {
      expect(matchPathPattern("/content/*/article", "/content/news/other")).toBe(-1);
    });

    it("prefix-matches beyond the pattern", () => {
      expect(matchPathPattern("/content/*/article", "/content/news/article/comments")).toBe(17);
    });
  });

  describe("catch-all wildcard", () => {
    it("matches any path", () => {
      expect(matchPathPattern("/*", "/anything")).toBe(1);
    });

    it("matches nested path", () => {
      expect(matchPathPattern("/*", "/a/b/c")).toBe(1);
    });
  });

  describe("anchored patterns with $", () => {
    it("matches exact path", () => {
      expect(matchPathPattern("/page$", "/page")).toBe(5);
    });

    it("rejects path with suffix", () => {
      expect(matchPathPattern("/page$", "/page/more")).toBe(-1);
    });

    it("works with mid-path wildcard", () => {
      expect(matchPathPattern("/content/*/article$", "/content/news/article")).toBe(17);
    });

    it("rejects suffix when anchored with wildcard", () => {
      expect(matchPathPattern("/content/*/article$", "/content/news/article/extra")).toBe(-1);
    });
  });

  describe("specificity", () => {
    it("more literal characters means higher specificity", () => {
      const broad = matchPathPattern("/*", "/content/news/article");
      const mid = matchPathPattern("/content/*", "/content/news/article");
      const specific = matchPathPattern("/content/*/article", "/content/news/article");
      expect(broad).toBeLessThan(mid);
      expect(mid).toBeLessThan(specific);
    });
  });
});
