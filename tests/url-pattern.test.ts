import { describe, it, expect } from "vitest";
import { scorePathPattern } from "../src/url-pattern";

describe("scorePathPattern", () => {
  describe("prefix matching without wildcards", () => {
    it("matches exact path", () => {
      expect(scorePathPattern("/content", "/content")).toBe(8);
    });

    it("matches at segment boundary", () => {
      expect(scorePathPattern("/content", "/content/article")).toBe(8);
    });

    it("does not match non-segment prefix", () => {
      expect(scorePathPattern("/content", "/content-other")).toBe(-1);
    });

    it("root prefix matches any path", () => {
      expect(scorePathPattern("/", "/anything")).toBe(1);
    });
  });

  describe("trailing wildcard", () => {
    it("matches sub-path", () => {
      expect(scorePathPattern("/content/*", "/content/article")).toBe(9);
    });

    it("matches across segments", () => {
      expect(scorePathPattern("/content/*", "/content/a/b")).toBe(9);
    });

    it("does not match unrelated path", () => {
      expect(scorePathPattern("/content/*", "/other")).toBe(-1);
    });
  });

  describe("mid-path wildcard", () => {
    it("matches single segment", () => {
      expect(scorePathPattern("/content/*/article", "/content/news/article")).toBe(17);
    });

    it("matches multiple segments", () => {
      expect(scorePathPattern("/content/*/article", "/content/a/b/article")).toBe(17);
    });

    it("does not match when suffix differs", () => {
      expect(scorePathPattern("/content/*/article", "/content/news/other")).toBe(-1);
    });

    it("prefix-matches beyond the pattern", () => {
      expect(scorePathPattern("/content/*/article", "/content/news/article/comments")).toBe(17);
    });
  });

  describe("catch-all wildcard", () => {
    it("matches any path", () => {
      expect(scorePathPattern("/*", "/anything")).toBe(1);
    });

    it("matches nested path", () => {
      expect(scorePathPattern("/*", "/a/b/c")).toBe(1);
    });
  });

  describe("anchored patterns with $", () => {
    it("matches exact path", () => {
      expect(scorePathPattern("/page$", "/page")).toBe(5);
    });

    it("rejects path with suffix", () => {
      expect(scorePathPattern("/page$", "/page/more")).toBe(-1);
    });

    it("works with mid-path wildcard", () => {
      expect(scorePathPattern("/content/*/article$", "/content/news/article")).toBe(17);
    });

    it("rejects suffix when anchored with wildcard", () => {
      expect(scorePathPattern("/content/*/article$", "/content/news/article/extra")).toBe(-1);
    });
  });

  describe("specificity", () => {
    it("more literal characters means higher specificity", () => {
      const broad = scorePathPattern("/*", "/content/news/article");
      const mid = scorePathPattern("/content/*", "/content/news/article");
      const specific = scorePathPattern("/content/*/article", "/content/news/article");
      expect(broad).toBeLessThan(mid);
      expect(mid).toBeLessThan(specific);
    });
  });
});
