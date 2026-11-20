import {
  ACCOUNT_DELETION_INVALID_CODE_MESSAGE,
  ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE,
} from "@/modules/account/constants";
import {
  type TAccountCodeActionFailure,
  isRateLimitServerError,
} from "@/modules/auth/lib/email-code/account-code-ui";

export type TAccountDeletionCodeError = "invalid_code" | "sole_owner" | "rate_limited" | "unknown";

/**
 * Why `deleteAccountWithCodeAction` or `requestAccountDeletionCodeAction` did not succeed, as one of the
 * answers the modal has translated text for. Matches the exact messages the server throws (shared
 * constants), never a substring of anything else.
 */
export const getAccountDeletionCodeError = (result: TAccountCodeActionFailure): TAccountDeletionCodeError => {
  const serverError = result?.serverError;
  if (isRateLimitServerError(serverError)) return "rate_limited";
  if (serverError === ACCOUNT_DELETION_INVALID_CODE_MESSAGE) return "invalid_code";
  if (serverError === ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE) return "sole_owner";
  // The only input is the code, so a schema refusal means the code was not 8 digits.
  if (result?.validationErrors) return "invalid_code";
  return "unknown";
};
