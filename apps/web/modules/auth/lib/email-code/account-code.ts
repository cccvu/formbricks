import "server-only";
import { logger } from "@formbricks/logger";
import type { TAccountCodePurpose } from "@/modules/email";
import { getRecipientTag } from "./tokens";

/** Error class from the error's name only. Messages can carry the address or provider detail. */
const classifyError = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : "unknown";

/**
 * Mails an account-change code (delete the account, confirm or verify an email change) and logs the
 * outcome by `recipientTag` and purpose only, never the address or the code. Never throws: returns
 * whether the mail was accepted, so each caller decides what the user sees.
 */
export const mailAccountCode = async ({
  to,
  code,
  purpose,
  locale,
  userId,
}: {
  to: string;
  code: string;
  purpose: TAccountCodePurpose;
  locale?: string | null;
  userId?: string;
}): Promise<boolean> => {
  const recipientTag = getRecipientTag(to);
  const startedAt = Date.now();
  try {
    // Dynamic, like the sign-in sender: keeps the mail graph out of the auth module's static imports.
    const { sendAccountCodeEmail } = await import("@/modules/email");
    const sent = await sendAccountCodeEmail({ to, code, purpose, locale, actorUserId: userId });
    const durationMs = Date.now() - startedAt;
    if (!sent) {
      logger.error(
        { event: "auth_account_code_send_failed", purpose, recipientTag, errorClass: "not_sent", durationMs },
        "Account code send failed"
      );
      return false;
    }
    logger.info(
      { event: "auth_account_code_issued", purpose, recipientTag, durationMs },
      "Account code sent"
    );
    return true;
  } catch (error) {
    logger.error(
      { event: "auth_account_code_send_failed", purpose, recipientTag, errorClass: classifyError(error) },
      "Account code send failed"
    );
    return false;
  }
};
