import {
  type TAccountCodeActionFailure,
  isRateLimitServerError,
} from "@/modules/auth/lib/email-code/account-code-ui";
import {
  EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE,
  EMAIL_CHANGE_INVALID_CODE_MESSAGE,
  EMAIL_CHANGE_SAME_EMAIL_MESSAGE,
} from "./email-change-messages";

export type TEmailChangeError = "invalid_code" | "email_in_use" | "same_email" | "rate_limited" | "unknown";

/**
 * Why an email-change action (email-code sign-in) did not succeed, as one of the answers the modal has
 * translated text for. Matches the exact messages the server throws (`email-change-messages.ts`).
 */
export const getEmailChangeError = (result: TAccountCodeActionFailure): TEmailChangeError => {
  const serverError = result?.serverError;
  if (isRateLimitServerError(serverError)) return "rate_limited";
  if (serverError === EMAIL_CHANGE_INVALID_CODE_MESSAGE) return "invalid_code";
  if (serverError === EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE) return "email_in_use";
  if (serverError === EMAIL_CHANGE_SAME_EMAIL_MESSAGE) return "same_email";
  const validationErrors = result?.validationErrors;
  // The form validates the new address before the modal opens, so a schema refusal is about the code.
  if (validationErrors && typeof validationErrors === "object" && "code" in validationErrors) {
    return "invalid_code";
  }
  return "unknown";
};
