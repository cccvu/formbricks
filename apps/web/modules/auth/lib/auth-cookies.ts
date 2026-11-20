import "server-only";
import { AUTH_URL } from "@/lib/constants";
import { env } from "@/lib/env";

/**
 * Cookie/token settings shared by `auth.ts`, the sign-up intent cookie (ENG-2562) and the proxy's
 * session-cookie reader (`session-cookie.ts`).
 *
 * Extracted rather than exported from `auth.ts` to keep the import graph acyclic: `signup-intent.ts`
 * is reached from `auth.ts` (→ `after-auth-hooks.ts` → `better-auth-verification-autosignin.ts`), so
 * importing `auth.ts` back from there would close a cycle. A leaf module both sides can import is the
 * cheap way out — the same reason `session-revocation.ts` reaches for `auth` dynamically.
 */

/**
 * `Secure` (and so `__Host-`) cookies require HTTPS — on http://localhost the browser drops them and the
 * session can't persist. Gate on the configured URL scheme (parity with NextAuth's URL-based
 * useSecureCookies default) instead of hardcoding true, so local/dev over http works.
 *
 * WEBAPP_URL is part of the chain because every one of these vars is optional: a deployment that sets
 * only WEBAPP_URL=https://… — the primary documented variable — would otherwise fall through to "" and
 * serve the session cookie without `Secure`, letting a downgrade to plaintext HTTP leak it (ENG-2076).
 */
export const USE_SECURE_COOKIES = (AUTH_URL ?? env.WEBAPP_URL ?? "").startsWith("https://");

/**
 * Prefix of every Better Auth cookie name (`advanced.cookiePrefix`), and of the sign-up intent cookie.
 *
 * On HTTPS it starts with `__Host-`: the browser only stores such a cookie when it is `Secure`, has
 * `Path=/` and has no `Domain`, so only this exact host can set it. `__Secure-` only forces `Secure`, so
 * a sibling subdomain could set a same-named `Domain=` cookie over ours (cookie tossing: login CSRF and
 * session fixation into an account the attacker controls).
 *
 * This is why `advanced.useSecureCookies` must stay `false`: Better Auth would prepend `__Secure-` to
 * every name, this prefix included. `Secure` comes from `AUTH_DEFAULT_COOKIE_ATTRIBUTES` instead, and
 * better-call's serializer forces `Secure` and `Path=/` (and drops `Domain`) for any `__Host-` name.
 * `auth-cookie-guard.ts` checks the result at boot.
 */
export const AUTH_COOKIE_PREFIX = USE_SECURE_COOKIES ? "__Host-formbricks" : "formbricks";

/** The session cookie Better Auth sets and reads; the only name the proxy accepts (`session-cookie.ts`). */
export const SESSION_TOKEN_COOKIE_NAME = `${AUTH_COOKIE_PREFIX}.session_token`;

/** Better Auth's `advanced.defaultCookieAttributes`: valid for `__Host-` (Secure on HTTPS, `/`, no Domain). */
export const AUTH_DEFAULT_COOKIE_ATTRIBUTES = {
  sameSite: "lax",
  httpOnly: true,
  secure: USE_SECURE_COOKIES,
  path: "/",
} as const;

/**
 * Lifetime of a verification link, and therefore of the sign-up intent cookie that has to outlive it.
 *
 * One constant on purpose: the intent cookie exists to answer "is the browser presenting this
 * verification link the one that registered?", so a cookie that died before the link it is paired with
 * would silently withhold the session from a legitimate same-browser sign-up — the exact UX ENG-1746
 * added and this fix is meant to preserve. Consumed by `emailVerification.expiresIn` in `auth.ts` and
 * by `issueSignupIntentCookie`.
 */
export const EMAIL_VERIFICATION_TTL_SECONDS = 60 * 60;
