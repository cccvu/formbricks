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
 * sign-in off they have no legitimate caller, so they answer 404 (`/reset-password` answers 403 first,
 * from the existing PASSWORD_RESET_DISABLED gate in the root hook).
 */
export const PASSWORD_ENDPOINT_PATHS = new Set([
  "/change-password",
  "/verify-password",
  "/reset-password",
  "/reset-password/:token",
]);

/**
 * Account changes by email code (passwordless account lifecycle). Better Auth's email-change endpoints run
 * only in-process, from the profile server actions: over HTTP they answer 404 whatever the spelling.
 */
export const EMAIL_CODE_REQUEST_EMAIL_CHANGE_PATH = "/email-otp/request-email-change";
export const EMAIL_CODE_CHANGE_EMAIL_PATH = "/email-otp/change-email";
export const EMAIL_CODE_IN_PROCESS_ONLY_PATHS = new Set([
  EMAIL_CODE_REQUEST_EMAIL_CHANGE_PATH,
  EMAIL_CODE_CHANGE_EMAIL_PATH,
]);

/**
 * Account deletion endpoints. With email codes on there is no password to confirm with, and the account
 * is deleted only by `deleteAccountWithCodeAction` (in-process), so over HTTP these answer 404: that closes
 * `POST /delete-user` as a password oracle and as a place to guess deletion codes without the action's
 * per-user limit.
 */
export const ACCOUNT_DELETION_PATHS = new Set(["/delete-user", "/delete-user/callback"]);

/**
 * Two-factor endpoints (every path the twoFactor plugin declares). Setting up or verifying a second factor
 * needs a password, and an account with 2FA cannot sign in by code, so with email codes on they have no
 * legitimate caller, over HTTP or in-process: enabling one would lock the account out.
 */
export const TWO_FACTOR_PATH_PREFIX = "/two-factor/";

/**
 * Account codes (delete the account, confirm or verify an email change): 8 digits, valid 10 minutes, single
 * use. The email-change codes are Better Auth's own (same options as sign-in, so 5 wrong guesses burn one);
 * the deletion code is Better Auth's delete-account token, minted by us as 8 digits.
 */
export const ACCOUNT_CODE_LENGTH = EMAIL_CODE_LENGTH;
export const ACCOUNT_CODE_TTL_SECONDS = EMAIL_CODE_TTL_SECONDS;
/** Better Auth's identifier for a delete-account token (`deleteUserCallback` consumes `<prefix><token>`). */
export const ACCOUNT_DELETION_TOKEN_IDENTIFIER_PREFIX = "delete-account-";
