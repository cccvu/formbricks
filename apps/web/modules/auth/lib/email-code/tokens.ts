import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ENCRYPTION_KEY } from "@/lib/constants";
import { EMAIL_CODE_DEVICE_TTL_SECONDS } from "./constants";

/**
 * Keyed hashes for the email-code flow. HMAC-SHA-256 from node:crypto only, keyed by subkeys derived
 * from ENCRYPTION_KEY with a fixed label, so rotating that key rotates these too.
 */
const deriveKey = (label: string): Buffer => createHmac("sha256", ENCRYPTION_KEY).update(label).digest();

let recipientTagKey: Buffer | undefined;
let deviceKey: Buffer | undefined;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * A stable, non-reversible tag for an address. Used in logs and Redis keys instead of the address.
 */
export const getRecipientTag = (email: string): string => {
  recipientTagKey ??= deriveKey("formbricks:email-code:recipient-tag:v1");
  return createHmac("sha256", recipientTagKey).update(normalizeEmail(email)).digest("hex").slice(0, 32);
};

const signDevice = (email: string, expiresAt: number): string => {
  deviceKey ??= deriveKey("formbricks:email-code:v1");
  return createHmac("sha256", deviceKey)
    .update(`${normalizeEmail(email)}.${expiresAt}`)
    .digest("base64url");
};

/** `<expiresAt unix seconds>.<mac>`: binds the cookie to one address and one expiry. */
export const createDeviceToken = (email: string, nowMs: number = Date.now()): string => {
  const expiresAt = Math.floor(nowMs / 1000) + EMAIL_CODE_DEVICE_TTL_SECONDS;
  return `${expiresAt}.${signDevice(email, expiresAt)}`;
};

export const isValidDeviceToken = (
  token: string | null | undefined,
  email: string,
  nowMs: number = Date.now()
): boolean => {
  if (!token || token.length > 128) return false;
  const [expiresAtRaw, mac, extra] = token.split(".");
  if (!expiresAtRaw || !mac || extra !== undefined || !/^\d{1,12}$/.test(expiresAtRaw)) return false;
  const expiresAt = Number(expiresAtRaw);
  if (expiresAt * 1000 <= nowMs) return false;
  const expected = Buffer.from(signDevice(email, expiresAt));
  const provided = Buffer.from(mac);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
};
