import "server-only";
import { isAPIError } from "better-auth/api";
import { logger } from "@formbricks/logger";
import {
  AuthenticationError,
  InvalidInputError,
  OperationNotAllowedError,
  UniqueConstraintError,
} from "@formbricks/types/errors";
import type { TUser } from "@formbricks/types/user";
import { EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";
import { revokeUserSessionsExcept } from "@/modules/auth/lib/session-revocation";
import {
  EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE,
  EMAIL_CHANGE_INVALID_CODE_MESSAGE,
  EMAIL_CHANGE_SAME_EMAIL_MESSAGE,
} from "./email-change-messages";

/**
 * Email change by codes (email-code sign-in). Better Auth's emailOTP change-email, run in-process from the
 * profile actions:
 *  1. a code to the CURRENT address (`createVerificationOTP`, server-only), which doubles as the notice;
 *  2. `requestEmailChangeEmailOTP` consumes that code (the address comes from the session, never the
 *     client) and mails a code to the new address, or nothing when another account has it;
 *  3. `changeEmailEmailOTP` consumes the new-address code and changes the address; then every other session
 *     is revoked.
 */

/**
 * Who may change their address by code: only with email-code sign-in on, and only an email-identity account
 * (an SSO account's address belongs to its identity provider, which re-asserts it on every sign-in).
 */
export const assertEmailChangeByCodeAllowed = (user: Pick<TUser, "identityProvider">): void => {
  if (!EMAIL_CODE_AUTH_ENABLED) {
    throw new OperationNotAllowedError("Email change by code is not enabled.");
  }
  if (user.identityProvider !== "email") {
    throw new OperationNotAllowedError("Email update is not allowed for non-credential users.");
  }
};

const INVALID_CODE_ERRORS = new Set(["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]);

/**
 * Maps Better Auth's email-change refusals to errors the action client returns verbatim (each an expected
 * error class, so its message reaches the client). Anything else is rethrown as it is: an unexpected error,
 * logged and answered with the generic message.
 */
export const toEmailChangeError = (error: unknown): unknown => {
  if (!isAPIError(error)) return error;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && INVALID_CODE_ERRORS.has(code)) {
    return new InvalidInputError(EMAIL_CHANGE_INVALID_CODE_MESSAGE);
  }
  if (error.message === "Email already in use") {
    return new UniqueConstraintError(EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE);
  }
  if (error.message === "Email is the same") return new InvalidInputError(EMAIL_CHANGE_SAME_EMAIL_MESSAGE);
  if (code === "INVALID_EMAIL") return new InvalidInputError("Invalid email");
  if (error.status === "UNAUTHORIZED") return new AuthenticationError("Not authenticated");
  return error;
};

/**
 * After the address changed, sign out every OTHER session: whoever else held one may have been the reason
 * for the change, and those sessions still carry the old address. Retries once, then gives up and says
 * so: the change itself stands (the codes from both mailboxes are the real control), and the leftover
 * sessions expire on their own (fixed session lifetime). Never throws.
 */
export const revokeOtherSessionsAfterEmailChange = async ({
  userId,
  keepSessionToken,
}: {
  userId: string;
  keepSessionToken: string | undefined;
}): Promise<boolean> => {
  // Without the current token, "all but this one" would sign the user out as well. Report a failure rather
  // than guess.
  if (!keepSessionToken) {
    logger.error(
      { event: "auth_account_email_change_revoke_failed", userId, reason: "no_current_session" },
      "Could not sign out other sessions after an email change"
    );
    return false;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await revokeUserSessionsExcept({ userId, keepSessionToken });
      return true;
    } catch (error) {
      if (attempt === 2) {
        logger.error(
          {
            event: "auth_account_email_change_revoke_failed",
            userId,
            errorClass: error instanceof Error ? error.name : "unknown",
          },
          "Could not sign out other sessions after an email change"
        );
      }
    }
  }
  return false;
};
