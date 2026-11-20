/**
 * `Cookie` request header hygiene for Proxy.
 *
 * Browsers apply the `__Host-` and `__Secure-` rules only to a name that starts with those exact bytes.
 * A sibling subdomain can therefore set `\xA0__Host-formbricks.session_token` (or any other non-token
 * name) with `Domain=` the parent domain. Node decodes the header as latin1, so 0xA0 arrives as U+00A0,
 * which `String.prototype.trim()` strips: a parser that trims names (better-call's `parseCookies` does)
 * would then read the planted value as the real `__Host-` cookie.
 *
 * A cookie name is an RFC 9110 token (RFC 6265 §4.1.1), and only spaces and tabs may surround a pair
 * (RFC 6265 §5.4). So Proxy drops every pair whose name is not a token before the header reaches any
 * downstream parser. Nothing this app sets has such a name, so no legitimate cookie is lost.
 */

// RFC 9110 §5.6.2 tchar: the only characters a cookie name may contain.
const COOKIE_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const isOptionalWhitespace = (char: string): boolean => char === " " || char === "\t";

/** Trim only spaces and tabs. `String.prototype.trim()` also strips U+00A0 and other Unicode spaces. */
export const trimCookiePair = (pair: string): string => {
  let start = 0;
  let end = pair.length;
  while (start < end && isOptionalWhitespace(pair[start])) start++;
  while (end > start && isOptionalWhitespace(pair[end - 1])) end--;
  return pair.slice(start, end);
};

const hasTokenName = (pair: string): boolean => {
  const separator = pair.indexOf("=");
  return separator > 0 && COOKIE_NAME_TOKEN.test(pair.slice(0, separator));
};

/** The header's `name=value` pairs whose name is a valid cookie token, trimmed of spaces and tabs. */
export const getValidCookiePairs = (cookieHeader: string): string[] =>
  cookieHeader.split(";").map(trimCookiePair).filter(hasTokenName);

/**
 * Remove every cookie pair with an invalid name from `headers` in place, deleting the header if none
 * is left. A header with nothing to drop is left byte for byte as it was.
 */
export const stripInvalidCookiePairs = (headers: Headers): void => {
  const cookieHeader = headers.get("cookie");
  if (cookieHeader === null) return;

  const pairs = cookieHeader.split(";").map(trimCookiePair);
  const validPairs = pairs.filter(hasTokenName);
  if (validPairs.length === pairs.filter((pair) => pair.length > 0).length) return;

  if (validPairs.length > 0) {
    headers.set("cookie", validPairs.join("; "));
  } else {
    headers.delete("cookie");
  }
};
