import "server-only";
import { prisma } from "@formbricks/database";
import { logger } from "@formbricks/logger";
import { mailAccountCode } from "./account-code";
import { isEmailCodeRecipientAdmitted } from "./admission";
import { EMAIL_CODE_SEND_FLOOR_MS } from "./constants";
import { getEmailCodePool } from "./device";
import { consumeEmailCodeSendQuota } from "./limits";
import { getRecipientTag } from "./tokens";

type TSendInput = { email: string; otp: string; type: string };
type TSendContext =
  | {
      getCookie?: (name: string) => string | null | undefined;
      request?: Request;
      /** Set by Better Auth's session middleware on the email-change endpoints. */
      context?: { session?: { user?: { id?: string } } | null };
    }
  | undefined;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Error class from the error's name only. Messages can carry the address or provider detail. */
const classifyError = (error: unknown): string =>
  error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : "unknown";

/**
 * When each send request started (set by the before-hook), so every path — refused in the hook or
 * mailed in the callback — pads to the same floor measured from the same instant.
 */
const sendRequestStartedAt = new WeakMap<Request, number>();

export const markEmailCodeSendStart = (request: Request | undefined, startedAt: number): void => {
  if (request) sendRequestStartedAt.set(request, startedAt);
};

export const padEmailCodeSendToFloor = async (startedAt: number): Promise<void> => {
  const remaining = EMAIL_CODE_SEND_FLOOR_MS - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
};

/**
 * Whether this send request may proceed to Better Auth at all: the address is admitted and within its
 * per-address send caps. Decided in the before-hook, BEFORE Better Auth writes a new code: Better Auth
 * stores (rotating away the previous code) before it calls the send callback, so a refusal decided in
 * the callback would still let anyone invalidate an address owner's emailed code at will.
 *
 * Fails closed (false) on any error. Never throws.
 */
export const shouldSendEmailCode = async (email: string, ctx: TSendContext): Promise<boolean> => {
  const recipientTag = getRecipientTag(email);
  try {
    if (!(await isEmailCodeRecipientAdmitted(email))) {
      logger.info(
        { event: "auth_email_code_suppressed", recipientTag, reason: "not_admitted" },
        "Email code not sent"
      );
      return false;
    }
    const pool = getEmailCodePool(ctx, email);
    if (!(await consumeEmailCodeSendQuota(recipientTag, pool))) {
      logger.warn(
        { event: "auth_email_code_throttled", recipientTag, pool, stage: "send" },
        "Email code throttled"
      );
      return false;
    }
    return true;
  } catch (error) {
    logger.error(
      { event: "auth_email_code_send_failed", recipientTag, errorClass: classifyError(error) },
      "Email code send failed"
    );
    return false;
  }
};

/**
 * The email-change half of the callback: Better Auth calls it from `/email-otp/request-email-change`, only
 * after the current-address code was proven and only when no account has the new address (it sends
 * nothing for a taken one). No admission check: the address is new by definition. That endpoint answers
 * 404 over HTTP, so this only ever runs inside the profile action, which pads its own response; there is
 * no request here to pad. Never throws.
 */
const sendEmailChangeCode = async (email: string, otp: string, ctx: TSendContext): Promise<void> => {
  const userId = ctx?.context?.session?.user?.id;
  let locale: string | undefined;
  try {
    if (userId) {
      locale = (await prisma.user.findUnique({ where: { id: userId }, select: { locale: true } }))?.locale;
    }
  } catch {
    // The default locale is fine; the code still goes out.
  }
  await mailAccountCode({ to: email, code: otp, purpose: "verify_new_email", locale, userId });
};

/**
 * The `sendVerificationOTP` callback Better Auth awaits. A `change-email` code goes to
 * `sendEmailChangeCode` above. A sign-in code is only reached for an admitted address within its caps (the
 * before-hook refused everything else with the same response): it mails the code Better Auth just stored
 * and pads to the floor measured from the start of the request. Any other type is never mailed.
 *
 * Never throws, so the response is Better Auth's fixed `{ success: true }` whatever SES does. The send is
 * awaited to completion inside the request (bounded by the transport's timeouts): nothing is left running
 * after the response, so a deploy cannot drop a code that was reported as sent.
 */
export const sendEmailCodeGated = async (
  { email, otp, type }: TSendInput,
  ctx?: TSendContext
): Promise<void> => {
  if (type === "change-email") return sendEmailChangeCode(email, otp, ctx);
  const startedAt = (ctx?.request && sendRequestStartedAt.get(ctx.request)) ?? Date.now();
  const recipientTag = getRecipientTag(email);
  try {
    if (type !== "sign-in") {
      logger.warn(
        { event: "auth_email_code_suppressed", recipientTag, reason: "type" },
        "Email code not sent"
      );
      return;
    }
    // Re-checked here as defence in depth (a read, no quota): the hook already decided.
    if (!(await isEmailCodeRecipientAdmitted(email))) {
      logger.info(
        { event: "auth_email_code_suppressed", recipientTag, reason: "not_admitted" },
        "Email code not sent"
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
    logger.info({ event: "auth_email_code_issued", recipientTag, durationMs }, "Email code sent");
    if (Date.now() - startedAt > EMAIL_CODE_SEND_FLOOR_MS) {
      logger.warn(
        { event: "auth_email_code_send_slow", recipientTag, durationMs },
        "Email code send exceeded the response floor"
      );
    }
  } catch (error) {
    logger.error(
      { event: "auth_email_code_send_failed", recipientTag, errorClass: classifyError(error) },
      "Email code send failed"
    );
  } finally {
    await padEmailCodeSendToFloor(startedAt);
  }
};
