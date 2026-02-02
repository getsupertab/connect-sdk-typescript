import { describe, it, expect } from "vitest";
import {
  parseContentElements,
  findBestMatchingContent,
  ContentBlock,
} from "../src/customer";

const sampleXml = `
<rsl xmlns="https://rslstandard.org/rsl">
  <content url="http://127.0.0.1:7676/*" server="http://127.0.0.1:8787">
    <license type="application/vnd.readium.license.status.v1.0+json">
      <link rel="self" href="http://127.0.0.1:8787/license" />
    </license>
  </content>
  <content url="http://127.0.0.1:7676/article/*" server="http://127.0.0.1:8787">
    <license type="application/vnd.readium.license.status.v1.0+json">
      <link rel="self" href="http://127.0.0.1:8787/license" />
    </license>
  </content>
</rsl>
`;

describe("parseContentElements", () => {
  it("parses multiple content blocks", () => {
    const blocks = parseContentElements(sampleXml);
    expect(blocks).toHaveLength(2);

    expect(blocks[0].urlPattern).toBe("http://127.0.0.1:7676/*");
    expect(blocks[0].server).toBe("http://127.0.0.1:8787");
    expect(blocks[0].licenseXml).toContain("<license");

    expect(blocks[1].urlPattern).toBe("http://127.0.0.1:7676/article/*");
    expect(blocks[1].server).toBe("http://127.0.0.1:8787");
    expect(blocks[1].licenseXml).toContain("<license");
  });

  it("skips content missing <license>", () => {
    const xml = `
      <content url="http://example.com/*" server="http://example.com">
        <p>No license here</p>
      </content>
    `;
    expect(parseContentElements(xml)).toEqual([]);
  });

  it("skips content missing url attribute", () => {
    const xml = `
      <content server="http://example.com">
        <license type="test"><link /></license>
      </content>
    `;
    expect(parseContentElements(xml)).toEqual([]);
  });

  it("skips content missing server attribute", () => {
    const xml = `
      <content url="http://example.com/*">
        <license type="test"><link /></license>
      </content>
    `;
    expect(parseContentElements(xml)).toEqual([]);
  });

  it("returns empty array for XML with no content elements", () => {
    const xml = `<root><other>stuff</other></root>`;
    expect(parseContentElements(xml)).toEqual([]);
  });
});

describe("findBestMatchingContent", () => {
  const blocks: ContentBlock[] = parseContentElements(sampleXml);

  it("exact path match wins", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/article/"
    );
    expect(result).not.toBeNull();
  });

  it("more-specific wildcard wins", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/article/*");
  });

  it("falls back to broader wildcard", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://127.0.0.1:7676/other"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/*");
  });

  it("no match for different host", () => {
    const result = findBestMatchingContent(
      blocks,
      "http://other-host:7676/article/foo"
    );
    expect(result).toBeNull();
  });

  it("skips invalid URL patterns gracefully", () => {
    const blocksWithBad: ContentBlock[] = [
      { urlPattern: "not-a-valid-url", server: "http://x", licenseXml: "<license/>" },
      ...blocks,
    ];
    const result = findBestMatchingContent(
      blocksWithBad,
      "http://127.0.0.1:7676/article/foo"
    );
    expect(result).not.toBeNull();
    expect(result!.urlPattern).toBe("http://127.0.0.1:7676/article/*");
  });
});
