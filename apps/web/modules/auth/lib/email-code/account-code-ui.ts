import { ACCOUNT_CODE_LENGTH, ACCOUNT_CODE_TTL_SECONDS } from "./constants";

/**
 * Client helpers for the account-change code forms (delete the account, change its email address) with
 * email-code sign-in on. Safe to import on the client.
 */

/** Seconds before "Resend code" is offered again, the same as on the sign-in form. */
export const ACCOUNT_CODE_RESEND_COOLDOWN_SECONDS = 60;

/** How long an emailed account code stays valid, in whole minutes (for the "expires in" copy). */
export const ACCOUNT_CODE_TTL_MINUTES = Math.round(ACCOUNT_CODE_TTL_SECONDS / 60);

/**
 * People type or paste codes as "1234 5678" or "1234-5678": keep only what `ZAccountCode` keeps (it drops
 * spaces and dashes), capped at the code's length.
 */
export const normalizeAccountCode = (value: string): string =>
  value.replaceAll(/[\s-]/g, "").slice(0, ACCOUNT_CODE_LENGTH);

const COMPLETE_ACCOUNT_CODE = new RegExp(String.raw`^\d{${ACCOUNT_CODE_LENGTH}}$`);

/** Whether a normalized code has exactly the code's digits, so it is worth sending. */
export const isCompleteAccountCode = (value: string): boolean => COMPLETE_ACCOUNT_CODE.test(value);

/**
 * The message `applyRateLimit` throws (modules/core/rate-limit/helpers.ts), which the action client returns
 * as `serverError`. Matched so the user is told to wait rather than shown the raw text.
 */
const RATE_LIMIT_SERVER_ERROR = "Maximum number of requests reached. Please try again later.";

export const isRateLimitServerError = (serverError: string | undefined): boolean =>
  serverError === RATE_LIMIT_SERVER_ERROR;

/** The part of a next-safe-action result the code forms read when an action did not succeed. */
export type TAccountCodeActionFailure =
  | {
      serverError?: string;
      validationErrors?: unknown;
    }
  | null
  | undefined;
