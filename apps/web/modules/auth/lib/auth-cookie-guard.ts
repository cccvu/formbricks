import "server-only";
import type { BetterAuthOptions } from "better-auth";
import { createCookieGetter } from "better-auth/cookies";
import { USE_SECURE_COOKIES } from "./auth-cookies";

/**
 * Every cookie Better Auth (and the plugins `auth.ts` mounts) names through `advanced.cookiePrefix`:
 * core's session, cache and remember-me cookies, the OAuth state cookies, and the two-factor ones.
 */
export const GUARDED_AUTH_COOKIES = [
  "session_token",
  "session_data",
  "dont_remember",
  "account_data",
  "state",
  "oauth_state",
  "two_factor",
  "trust_device",
] as const;

const describeViolations = (options: BetterAuthOptions): string[] => {
  // Better Auth's own getter, so this checks the names and attributes the deployed version would emit.
  const createCookie = createCookieGetter(options);

  return GUARDED_AUTH_COOKIES.flatMap((cookie) => {
    const { name, attributes } = createCookie(cookie);
    const problems: string[] = [];
    if (!name.startsWith("__Host-")) problems.push("name is not __Host- prefixed");
    if (attributes.secure !== true) problems.push("not Secure");
    if (attributes.path !== "/") problems.push(`Path=${attributes.path ?? "(unset)"}`);
    if (attributes.domain) problems.push(`Domain=${attributes.domain}`);
    return problems.length > 0 ? [`${name}: ${problems.join(", ")}`] : [];
  });
};

/**
 * Refuse to load the auth module on HTTPS unless every Better Auth cookie is a valid `__Host-` cookie:
 * `__Host-` name, `Secure`, `Path=/`, no `Domain` (see `AUTH_COOKIE_PREFIX` in `auth-cookies.ts`).
 *
 * A browser silently drops a `__Host-` cookie that breaks those rules, and a `__Secure-` or unprefixed
 * one can be overwritten from a sibling subdomain. Either would follow from a config change or a Better
 * Auth upgrade that changes how names or attributes are derived, so this fails loudly at boot instead.
 * Does nothing over plain http, where none of these cookies can be `Secure`.
 */
export const assertHostPrefixedAuthCookies = (options: BetterAuthOptions): void => {
  if (!USE_SECURE_COOKIES) return;

  const violations = describeViolations(options);
  if (violations.length > 0) {
    throw new Error(
      `Better Auth cookies must be __Host- cookies (Secure, Path=/, no Domain) on HTTPS: ${violations.join("; ")}`
    );
  }
};
