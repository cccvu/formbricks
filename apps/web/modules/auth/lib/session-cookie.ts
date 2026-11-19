import { createHmac } from "node:crypto";
import { AUTH_SECRET } from "@/lib/constants";
import { constantTimeEqual } from "@/lib/crypto";
import { SESSION_TOKEN_COOKIE_NAME } from "./auth-cookies";

/**
 * The session cookie is read under exactly one name: `SESSION_TOKEN_COOKIE_NAME`, the one Better Auth
 * sets and reads (`__Host-formbricks.session_token` on HTTPS, `formbricks.session_token` on http).
 *
 * No fallback to another name, on purpose. A sibling subdomain can set `formbricks.session_token` or
 * `__Secure-formbricks.session_token` for this host with `Domain=`, and a validly signed value is easy
 * to come by: it is the attacker's own session. Accepting either would sign the victim into the
 * attacker's account here even though Better Auth itself ignores those names. One name also means the
 * proxy and Better Auth can never disagree about whether a request is signed in.
 */

type TCookieStore = {
  get: (name: string) => { value: string } | undefined;
};

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

/**
 * Verify Better Auth's signed cookie value and return the unsigned session token (the value stored
 * in `Session.sessionToken`), or `null` if absent or tampered with.
 *
 * Better Auth signs the cookie via better-call's `serializeSignedCookie`: the value is
 * `` `${token}.${signature}` `` where `signature = base64(HMAC-SHA256(token, BETTER_AUTH_SECRET))`
 * (standard base64; see better-call `crypto.mjs` `makeSignature`). We recompute that HMAC with the
 * same secret and constant-time-compare — so a raw `prisma.session.findUnique` can look the token up.
 * Fails closed: a missing secret or an invalid signature returns `null`.
 */
const verifyAndExtractSessionToken = (signedValue: string | null): string | null => {
  // The same resolved secret auth.ts hands Better Auth, so this verifies the cookies BA actually
  // signs — a mismatch rejects every session and loops the user between / and /auth/login. Fails
  // closed when no secret is set.
  const secret = AUTH_SECRET;
  if (!signedValue || !secret) {
    return null;
  }

  // The token is a cuid2 (no "."), the signature is standard base64 (no "."), so the single "."
  // cleanly separates them.
  const lastDot = signedValue.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === signedValue.length - 1) {
    return null;
  }

  const token = signedValue.slice(0, lastDot);
  const signature = signedValue.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(token).digest("base64");

  if (!constantTimeEqual(expected, signature)) {
    return null;
  }

  return token;
};

const getSignedCookieValueFromHeader = (cookieHeader: string, cookieName: string): string | null => {
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    if (!cookie.startsWith(`${cookieName}=`)) {
      continue;
    }

    const cookieValue = cookie.slice(cookieName.length + 1);
    return cookieValue.length > 0 ? decode(cookieValue) : null;
  }

  return null;
};

/** The verified, unsigned Better Auth session token from a cookie store, or null. */
export const getSessionTokenFromCookieStore = (cookieStore: TCookieStore): string | null => {
  const cookie = cookieStore.get(SESSION_TOKEN_COOKIE_NAME);
  return cookie?.value ? verifyAndExtractSessionToken(decode(cookie.value)) : null;
};

/** The verified, unsigned Better Auth session token from a `Cookie` header, or null. */
export const getSessionTokenFromCookieHeader = (cookieHeader: string | null): string | null => {
  if (!cookieHeader) {
    return null;
  }

  const signedValue = getSignedCookieValueFromHeader(cookieHeader, SESSION_TOKEN_COOKIE_NAME);
  return verifyAndExtractSessionToken(signedValue);
};
