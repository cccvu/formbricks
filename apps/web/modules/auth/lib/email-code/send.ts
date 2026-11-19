import "server-only";
import { logger } from "@formbricks/logger";
import { isEmailCodeRecipientAdmitted } from "./admission";
import { EMAIL_CODE_SEND_FLOOR_MS } from "./constants";
import { getEmailCodePool } from "./device";
import { consumeEmailCodeSendQuota } from "./limits";
import { getRecipientTag } from "./tokens";

type TSendInput = { email: string; otp: string; type: string };
type TCookieReader = { getCookie?: (name: string) => string | null | undefined } | undefined;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Error class from the error's name only. Messages can carry the address or provider detail. */
const classifyError = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : "unknown";

/**
 * The `sendVerificationOTP` callback Better Auth awaits on every send request. Better Auth has already
 * stored a code for the address (for ANY address, eligible or not); this decides whether to mail it.
 *
 * Never throws and always returns after the same floor, so the response (Better Auth's fixed
 * `{ success: true }`) and its timing are the same for every address and every SES outcome. The send
 * itself is awaited to completion inside the request (bounded by the transport's timeouts): nothing is
 * left running after the response, so a deploy cannot drop a code that was reported as sent.
 */
export const sendEmailCodeGated = async (
  { email, otp, type }: TSendInput,
  ctx?: TCookieReader
): Promise<void> => {
  const startedAt = Date.now();
  const recipientTag = getRecipientTag(email);
  try {
    if (type !== "sign-in") {
      logger.warn(
        { event: "auth_email_code_suppressed", recipientTag, reason: "type" },
        "Email code not sent"
      );
      return;
    }
    if (!(await isEmailCodeRecipientAdmitted(email))) {
      logger.info(
        { event: "auth_email_code_suppressed", recipientTag, reason: "not_admitted" },
        "Email code not sent"
      );
      return;
    }
    const pool = getEmailCodePool(ctx, email);
    if (!(await consumeEmailCodeSendQuota(recipientTag, pool))) {
      logger.warn(
        { event: "auth_email_code_throttled", recipientTag, pool, stage: "send" },
        "Email code throttled"
      );
      return;
    }

    const { sendSignInCodeEmail } = await import("@/modules/email");
    const sendStartedAt = Date.now();
    const sent = await sendSignInCodeEmail(email, otp);
    const durationMs = Date.now() - sendStartedAt;
    if (!sent) {
      logger.error(
        { event: "auth_email_code_send_failed", recipientTag, errorClass: "not_sent", durationMs },
        "Email code send failed"
      );
      return;
    }
    logger.info({ event: "auth_email_code_issued", recipientTag, pool, durationMs }, "Email code sent");
    if (Date.now() - startedAt > EMAIL_CODE_SEND_FLOOR_MS) {
      logger.warn(
        { event: "auth_email_code_send_slow", recipientTag, durationMs },
        "Email code send exceeded the response floor"
      );
    }
  } catch (error) {
    // Redis down, database down, or the transport failed: fail closed (no mail), same response.
    logger.error(
      { event: "auth_email_code_send_failed", recipientTag, errorClass: classifyError(error) },
      "Email code send failed"
    );
  } finally {
    const remaining = EMAIL_CODE_SEND_FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }
};
