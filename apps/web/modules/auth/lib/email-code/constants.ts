/**
 * Email-code sign-in (EMAIL_CODE_AUTH_ENABLED). One place for every number the flow depends on, so the
 * tests, the docs and the code cannot drift apart.
 *
 * Sources: NIST SP 800-63B-4 §3.1.3 (out-of-band secret ≥ 6 digits, valid ≤ 10 minutes, single use,
 * rate-limited) and OWASP ASVS 5.0 V6.
 */

/** Better Auth endpoint paths (the declared `ctx.path`, not the request URL). */
export const EMAIL_CODE_SEND_PATH = "/email-otp/send-verification-otp";
export const EMAIL_CODE_SIGN_IN_PATH = "/sign-in/email-otp";

/** 8 decimal digits = 10^8 codes; 5 guesses per code and 10 per address per day keep the odds negligible. */
export const EMAIL_CODE_LENGTH = 8;
/** A code is valid for 10 minutes from issue. A resend rotates it (the old one stops working). */
export const EMAIL_CODE_TTL_SECONDS = 600;
/** Wrong guesses allowed against one code before it is burned (enforced by Better Auth). */
export const EMAIL_CODE_ALLOWED_ATTEMPTS = 5;

/**
 * Every send request takes at least this long, whatever the address and whatever SES does, so the
 * response time does not say whether an email was sent.
 */
export const EMAIL_CODE_SEND_FLOOR_MS = 1500;

/** Per-address send caps, checked in order (shortest window first). */
export const EMAIL_CODE_SEND_LIMITS = [
  { windowSeconds: 60, max: 1 },
  { windowSeconds: 15 * 60, max: 5 },
  { windowSeconds: 24 * 60 * 60, max: 10 },
] as const;

/**
 * Per-address sign-in attempts (right or wrong) per day, across all codes. Independent of
 * RATE_LIMITING_DISABLED, and not reset by a resend.
 */
export const EMAIL_CODE_VERIFY_LIMIT = { windowSeconds: 24 * 60 * 60, max: 10 } as const;

/**
 * The trusted-device cookie. A browser that signed in to an address before gets its own counters for
 * that address, so a stranger who burns the shared pool cannot lock the owner out of a known device.
 */
export const EMAIL_CODE_DEVICE_COOKIE_NAME = "formbricks.email_code_device";
export const EMAIL_CODE_DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Body keys each endpoint accepts. Anything else (`name`, `image`, `isBootstrapAdmin`, …) is refused. */
export const EMAIL_CODE_SEND_BODY_KEYS = new Set(["email", "type", "oauth_query"]);
export const EMAIL_CODE_SIGN_IN_BODY_KEYS = new Set(["email", "otp", "oauth_query"]);

/**
 * Password endpoints that stay registered by Better Auth core. With email-code sign-in on and password
 * sign-in off they have no legitimate caller, so they answer 404.
 */
export const PASSWORD_ENDPOINT_PATHS = new Set([
  "/change-password",
  "/verify-password",
  "/reset-password",
  "/reset-password/:token",
]);
