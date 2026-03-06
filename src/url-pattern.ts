/**
 * Match a URL path against a robots.txt-style pattern.
 *
 * - `*` matches zero or more characters (including `/`)
 * - Trailing `$` anchors the match to the end of the path
 * - Without `$`, patterns without `*` match as prefix at segment boundaries
 *   (e.g. `/content` matches `/content/article` but not `/content-other`)
 * - Without `$`, patterns with `*` are prefix-matched from the start
 *
 * Returns specificity (number of literal characters) on match, or -1 on no match.
 */
export function scorePathPattern(pattern: string, path: string): number {
  let anchored = false;
  let pat = pattern;

  if (pat.endsWith("$")) {
    anchored = true;
    pat = pat.slice(0, -1);
  }

  const hasWildcard = pat.includes("*");

  // Escape regex special chars (except *) and treat them as literals
  const escaped = pat.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
  // Converts wildcard * to regex equivalent .*
  const regexBody = escaped.replace(/\*/g, ".*");

  let regexStr: string;
  if (anchored) {
    regexStr = `^${regexBody}$`;
  } else if (hasWildcard) {
    regexStr = `^${regexBody}`;
  } else {
    // No wildcards, no anchor: prefix match at segment boundary
    // Special case: "/" matches all paths
    if (pat === "/") {
      regexStr = `^/`;
    } else {
      regexStr = `^${regexBody}(/|$)`;
    }
  }

  if (new RegExp(regexStr).test(path)) {
    return pat.replace(/\*/g, "").length;
  }

  return -1;
}
