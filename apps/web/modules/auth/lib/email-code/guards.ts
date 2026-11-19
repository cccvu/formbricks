import "server-only";
import type { BetterAuthOptions } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { prisma } from "@formbricks/database";
import { logger } from "@formbricks/logger";
import { EMAIL_AUTH_ENABLED } from "@/lib/constants";
import type { AuthHookContext } from "@/modules/ee/sso/lib/better-auth-hooks";
import { hasPendingInviteForEmail } from "./admission";
import {
  EMAIL_CODE_SEND_BODY_KEYS,
  EMAIL_CODE_SEND_PATH,
  EMAIL_CODE_SIGN_IN_BODY_KEYS,
  EMAIL_CODE_SIGN_IN_PATH,
  PASSWORD_ENDPOINT_PATHS,
} from "./constants";
import { getEmailCodePool, setEmailCodeDeviceCookie } from "./device";
import { type TEmailCodePool, consumeEmailCodeVerifyQuota } from "./limits";
import { markEmailCodeSendStart, padEmailCodeSendToFloor, shouldSendEmailCode } from "./send";
import { getRecipientTag, normalizeEmail } from "./tokens";

/**
 * Byte-identical to Better Auth's own wrong-code error (`EMAIL_OTP_ERROR_CODES.INVALID_OTP`), so every
 * sign-in failure that depends on the address looks the same as a wrong code.
 */
export const invalidEmailCodeError = (): APIError =>
  new APIError("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" });

const notFound = (): APIError => new APIError("NOT_FOUND");

/** Paths this module guards. Used as the plugin hook matcher. */
export const isEmailCodeGuardedPath = (path: string | undefined): boolean =>
  !!path &&
  (path.startsWith("/email-otp/") || path === EMAIL_CODE_SIGN_IN_PATH || PASSWORD_ENDPOINT_PATHS.has(path));

const assertTrustedOrigin = (ctx: AuthHookContext): void => {
  const origin = ctx.headers?.get("origin");
  if (!origin || !ctx.context.isTrustedOrigin(origin)) {
    throw new APIError("FORBIDDEN", { message: "Invalid origin" });
  }
};

const assertBodyKeys = (ctx: AuthHookContext, allowed: Set<string>): Record<string, unknown> => {
  const body: unknown = ctx.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new APIError("BAD_REQUEST", { message: "Invalid request body" });
  }
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new APIError("BAD_REQUEST", { message: "Invalid request body" });
  }
  return body as Record<string, unknown>;
};

/**
 * `hooks.before` for the email-code plugin. Keyed on the DECLARED endpoint path, which does not depend on
 * how the request URL was spelled. Every refusal here is either independent of the address (origin,
 * body shape, type) or identical to a wrong code (the per-address cap).
 */
const handleSendBefore = async (ctx: AuthHookContext) => {
  assertTrustedOrigin(ctx);
  const body = assertBodyKeys(ctx, EMAIL_CODE_SEND_BODY_KEYS);
  if (body.type !== "sign-in") throw new APIError("BAD_REQUEST", { message: "Invalid OTP type" });
  if (typeof body.email !== "string") throw new APIError("BAD_REQUEST", { message: "Invalid request body" });
  const startedAt = Date.now();
  markEmailCodeSendStart(ctx.request, startedAt);
  if (await shouldSendEmailCode(body.email, ctx)) return; // Better Auth stores a new code and mails it.
  // Not admitted, or over its caps: answer exactly as a real send does, WITHOUT letting Better Auth
  // store a new code. Rotating here would let anyone kill an owner's emailed code by asking for another.
  await padEmailCodeSendToFloor(startedAt);
  return ctx.json({ success: true });
};

const consumeVerifyQuotaFailClosed = async (recipientTag: string, pool: TEmailCodePool): Promise<boolean> => {
  try {
    // Counted BEFORE Better Auth compares the code, so parallel guesses cannot overshoot the cap.
    return await consumeEmailCodeVerifyQuota(recipientTag, pool);
  } catch {
    return false; // Redis down: fail closed.
  }
};

const handleSignInBefore = async (ctx: AuthHookContext): Promise<void> => {
  assertTrustedOrigin(ctx);
  const body = assertBodyKeys(ctx, EMAIL_CODE_SIGN_IN_BODY_KEYS);
  if (typeof body.email !== "string" || typeof body.otp !== "string") {
    throw new APIError("BAD_REQUEST", { message: "Invalid request body" });
  }
  const recipientTag = getRecipientTag(body.email);
  const pool = getEmailCodePool(ctx, body.email);
  if (!(await consumeVerifyQuotaFailClosed(recipientTag, pool))) {
    logger.warn(
      { event: "auth_email_code_throttled", recipientTag, pool, stage: "verify" },
      "Email code throttled"
    );
    throw invalidEmailCodeError();
  }
};

export const emailCodeBeforeHandler = async (ctx: AuthHookContext) => {
  const path = ctx.path;
  // Password sign-in is off, so the password endpoints Better Auth core still mounts have no caller.
  if (PASSWORD_ENDPOINT_PATHS.has(path)) {
    if (!EMAIL_AUTH_ENABLED) throw notFound();
    return;
  }
  if (path === EMAIL_CODE_SEND_PATH) return handleSendBefore(ctx);
  // Only send is served under /email-otp/*. Anything a future plugin version adds there stays closed.
  if (path.startsWith("/email-otp/")) throw notFound();
  if (path === EMAIL_CODE_SIGN_IN_PATH) await handleSignInBefore(ctx);
};

/**
 * `hooks.after` for `/sign-in/email-otp`. Folds "too many attempts" and "expired" into the wrong-code
 * error (both would otherwise say a code exists for the address), logs the outcome, and on success marks
 * this browser as a trusted device for the address.
 */
export const emailCodeAfterHandler = async (ctx: AuthHookContext): Promise<Response | undefined> => {
  if (ctx.path !== EMAIL_CODE_SIGN_IN_PATH) return;
  const email = typeof ctx.body?.email === "string" ? ctx.body.email : undefined;
  const recipientTag = email ? getRecipientTag(email) : undefined;
  const returned = (ctx.context as { returned?: unknown }).returned;

  if (isAPIError(returned)) {
    const code = (returned.body as { code?: unknown } | undefined)?.code;
    logger.info(
      {
        event: "auth_email_code_verify_failed",
        recipientTag,
        reason: typeof code === "string" ? code : returned.status,
      },
      "Email code sign-in failed"
    );
    if (code !== "TOO_MANY_ATTEMPTS" && code !== "OTP_EXPIRED") return;
    const error = invalidEmailCodeError();
    // Over HTTP, Better Auth keeps the status of the error the endpoint threw when an after hook replaces
    // it (`dispatch.mjs` passes `result.status` to `toResponse`), so a thrown 400 would still go out as
    // TOO_MANY_ATTEMPTS's 403. Answer with the complete wrong-code response instead.
    if (ctx.request) {
      return new Response(JSON.stringify(error.body), {
        status: error.statusCode,
        statusText: error.status.toString(),
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  }

  if (ctx.context.newSession && email) {
    setEmailCodeDeviceCookie(ctx, email);
    logger.info({ event: "auth_email_code_redeemed", recipientTag }, "Email code sign-in succeeded");
  }
};

type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type UserCreateBefore = NonNullable<NonNullable<NonNullable<DatabaseHooks["user"]>["create"]>["before"]>;
type SessionCreateBefore = NonNullable<
  NonNullable<NonNullable<DatabaseHooks["session"]>["create"]>["before"]
>;

/** A display name for a code-created account: the address's local part, which the user can change. */
export const deriveNameFromEmail = (email: string): string =>
  normalizeEmail(email).split("@")[0].slice(0, 64) || "User";

/**
 * Wraps the existing `user.create.before` (which, for a non-SSO creation, runs the credential sign-up
 * backstop) for accounts created by `/sign-in/email-otp`:
 *  - a pending, unexpired invite for this exact address admits it (no bootstrap marker); it is re-read
 *    here, at creation time, so an invite revoked after the code was sent no longer admits;
 *  - otherwise the backstop decides (fresh instance + INITIAL_ADMIN_EMAIL, or open sign-up) and throws
 *    when the instance is closed, so no row is written;
 *  - a silent `false` from the backstop becomes an error, because Better Auth's sign-in route reads
 *    `newUser.id` without a null check.
 */
export const withEmailCodeUserCreate =
  (inner: UserCreateBefore): UserCreateBefore =>
  async (user, context) => {
    if (context?.path !== EMAIL_CODE_SIGN_IN_PATH) return inner(user, context);
    const name =
      typeof user.name === "string" && user.name.trim() ? user.name : deriveNameFromEmail(user.email);
    if (await hasPendingInviteForEmail(user.email)) return { data: { name } };
    const result = await inner(user, context);
    if (result === false) throw invalidEmailCodeError();
    const data = result && typeof result === "object" && "data" in result ? result.data : {};
    return { data: { ...data, name } };
  };

/**
 * `session.create.before` addition: a code from the mailbox is never enough for an account that has
 * two-factor auth (the code is not a second factor, and Better Auth's twoFactor plugin does not
 * challenge this path), nor for an SSO account (that would bypass the IdP). Runs only after the code was
 * proven, so it reveals nothing to someone without the mailbox.
 */
export const rejectEmailCodeSessionForIneligibleUser: SessionCreateBefore = async (session, context) => {
  if (context?.path !== EMAIL_CODE_SIGN_IN_PATH) return;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { twoFactorEnabled: true, identityProvider: true },
  });
  if (!user || user.twoFactorEnabled || user.identityProvider !== "email") {
    logger.warn(
      { event: "auth_email_code_session_refused" },
      "Email code sign-in refused for this account type"
    );
    throw invalidEmailCodeError();
  }
};
