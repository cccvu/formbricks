import "server-only";
import { USE_SECURE_COOKIES } from "../auth-cookies";
import { EMAIL_CODE_DEVICE_COOKIE_NAME, EMAIL_CODE_DEVICE_TTL_SECONDS } from "./constants";
import type { TEmailCodePool } from "./limits";
import { createDeviceToken, isValidDeviceToken } from "./tokens";

/** `__Host-` over HTTPS: Secure, Path=/, no Domain, so no sibling subdomain can set or read it. */
export const getEmailCodeDeviceCookieName = (): string =>
  USE_SECURE_COOKIES ? `__Host-${EMAIL_CODE_DEVICE_COOKIE_NAME}` : EMAIL_CODE_DEVICE_COOKIE_NAME;

type TCookieReader = { getCookie?: (name: string) => string | null | undefined } | undefined;
type TCookieWriter = {
  setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown;
};

export const getEmailCodePool = (ctx: TCookieReader, email: string): TEmailCodePool => {
  const token = ctx?.getCookie?.(getEmailCodeDeviceCookieName());
  return isValidDeviceToken(token, email) ? "device" : "shared";
};

export const setEmailCodeDeviceCookie = (ctx: TCookieWriter, email: string): void => {
  ctx.setCookie(getEmailCodeDeviceCookieName(), createDeviceToken(email), {
    httpOnly: true,
    secure: USE_SECURE_COOKIES,
    sameSite: "lax",
    path: "/",
    maxAge: EMAIL_CODE_DEVICE_TTL_SECONDS,
  });
};
