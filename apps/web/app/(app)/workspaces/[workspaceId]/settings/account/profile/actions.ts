"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { logger } from "@formbricks/logger";
import {
  AuthenticationError,
  AuthorizationError,
  OperationNotAllowedError,
  TooManyRequestsError,
} from "@formbricks/types/errors";
import {
  TUserPersonalInfoUpdateInput,
  TUserUpdateInput,
  ZUserPersonalInfoUpdateInput,
} from "@formbricks/types/user";
import {
  assertEmailChangeByCodeAllowed,
  revokeOtherSessionsAfterEmailChange,
  toEmailChangeError,
} from "@/app/(app)/workspaces/[workspaceId]/settings/account/profile/lib/email-change";
import { getIsEmailUnique } from "@/app/(app)/workspaces/[workspaceId]/settings/account/profile/lib/user";
import {
  EMAIL_CODE_AUTH_ENABLED,
  EMAIL_VERIFICATION_DISABLED,
  PASSWORD_RESET_DISABLED,
  WEBAPP_URL,
} from "@/lib/constants";
import { verifyUserPassword } from "@/lib/user/password";
import { getUser, updateUser } from "@/lib/user/service";
import { authenticatedActionClient } from "@/lib/utils/action-client";
import { AuthenticatedActionClientCtx } from "@/lib/utils/action-client/types/context";
import { auth } from "@/modules/auth/lib/auth";
import { updateBrevoCustomer } from "@/modules/auth/lib/brevo";
import { mailAccountCode } from "@/modules/auth/lib/email-code/account-code";
import { ZAccountCode, ZNewEmailAddress } from "@/modules/auth/lib/email-code/account-code-input";
import { EMAIL_CODE_SEND_FLOOR_MS } from "@/modules/auth/lib/email-code/constants";
import { applyRateLimit } from "@/modules/core/rate-limit/helpers";
import { rateLimitConfigs } from "@/modules/core/rate-limit/rate-limit-configs";
import { withAuditLogging } from "@/modules/ee/audit-logs/lib/handler";
import { sendVerificationNewEmail } from "@/modules/email";

function buildUserUpdatePayload(parsedInput: TUserPersonalInfoUpdateInput): TUserUpdateInput {
  return {
    ...(parsedInput.name && { name: parsedInput.name }),
    ...(parsedInput.locale && { locale: parsedInput.locale }),
  };
}

/**
 * Refuse a name change for an SSO user, mirroring the identical guard `handleEmailUpdate` applies to
 * the address.
 *
 * The identity provider owns `User.name` — it is re-read on every sign-in (`overrideUserInfo` in
 * modules/ee/sso/lib/better-auth-providers.ts) — so `EditProfileDetailsForm` renders the input
 * disabled. That is presentation, not enforcement: this action takes `name` straight off the request,
 * so a crafted call would still land a write that sticks until the user's next sign-in silently
 * reverts it. Enforce it at the boundary instead.
 *
 * Only a *differing* name is rejected. The form omits untouched fields, but a client that echoes the
 * current value back is asking for no change, and erroring on that would be a false positive.
 */
function assertNameUpdateAllowed({
  ctx,
  parsedInput,
}: {
  ctx: AuthenticatedActionClientCtx;
  parsedInput: TUserPersonalInfoUpdateInput;
}): void {
  const inputName = parsedInput.name?.trim();
  if (!inputName || inputName === ctx.user.name) return;

  if (ctx.user.identityProvider !== "email") {
    throw new OperationNotAllowedError("Name update is not allowed for non-credential users.");
  }
}

async function handleEmailUpdate({
  ctx,
  parsedInput,
  payload,
}: {
  ctx: AuthenticatedActionClientCtx;
  parsedInput: TUserPersonalInfoUpdateInput;
  payload: TUserUpdateInput;
}) {
  const inputEmail = parsedInput.email?.trim().toLowerCase();
  if (!inputEmail || ctx.user.email === inputEmail) return payload;

  // With email-code sign-in there is no password to confirm with, and the address changes only through the
  // code actions below, which prove both mailboxes.
  if (EMAIL_CODE_AUTH_ENABLED) {
    throw new OperationNotAllowedError("Change your email address with the emailed codes.");
  }

  await applyRateLimit(rateLimitConfigs.actions.emailUpdate, ctx.user.id);

  if (ctx.user.identityProvider !== "email") {
    throw new OperationNotAllowedError("Email update is not allowed for non-credential users.");
  }
  if (!parsedInput.password) {
    throw new AuthenticationError("Password is required to update email.");
  }
  const isCorrectPassword = await verifyUserPassword(ctx.user.id, parsedInput.password);
  if (!isCorrectPassword) {
    throw new AuthorizationError("Incorrect credentials");
  }
  const isEmailUnique = await getIsEmailUnique(inputEmail);
  if (!isEmailUnique) return payload;

  if (EMAIL_VERIFICATION_DISABLED) {
    payload.email = inputEmail;
    await updateBrevoCustomer({ id: ctx.user.id, email: inputEmail });
  } else {
    try {
      await sendVerificationNewEmail(ctx.user.id, inputEmail, ctx.user.locale);
    } catch (error) {
      // A taken address returns quietly above, so a capped email (ENG-3823) must too, or the refusal would
      // tell the user which addresses are free.
      if (!(error instanceof TooManyRequestsError)) throw error;
    }
  }
  return payload;
}

export const updateUserAction = authenticatedActionClient.inputSchema(ZUserPersonalInfoUpdateInput).action(
  withAuditLogging("updated", "user", async ({ ctx, parsedInput }) => {
    const oldObject = await getUser(ctx.user.id);
    assertNameUpdateAllowed({ ctx, parsedInput });
    let payload = buildUserUpdatePayload(parsedInput);
    payload = await handleEmailUpdate({ ctx, parsedInput, payload });

    // Only proceed with updateUser if we have actual changes to make
    let newObject = oldObject;
    if (Object.keys(payload).length > 0) {
      newObject = await updateUser(ctx.user.id, payload);
    }

    ctx.auditLoggingCtx.userId = ctx.user.id;
    ctx.auditLoggingCtx.oldObject = oldObject;
    ctx.auditLoggingCtx.newObject = newObject;

    return true;
  })
);

export const resetPasswordAction = authenticatedActionClient.action(
  withAuditLogging("passwordReset", "user", async ({ ctx }) => {
    if (PASSWORD_RESET_DISABLED) {
      throw new OperationNotAllowedError("Password reset is disabled");
    }

    if (ctx.user.identityProvider !== "email") {
      throw new OperationNotAllowedError("Password reset is not allowed for this user.");
    }

    // Without a limit this was the one way to have reset emails sent unbounded. A budget of its own, so
    // strangers spending forgot-password's per-account budget cannot lock the user out of this one.
    await applyRateLimit(rateLimitConfigs.actions.passwordResetRequest, ctx.user.id);

    await auth.api.requestPasswordReset({
      body: { email: ctx.user.email, redirectTo: `${WEBAPP_URL}/auth/forgot-password/reset` },
      headers: await headers(),
    });

    ctx.auditLoggingCtx.userId = ctx.user.id;

    return { success: true };
  })
);

/*
 * Email change by codes, with email-code sign-in on (EMAIL_CODE_AUTH_ENABLED). Server actions are legacy in
 * this codebase, but these extend the profile flow this file already owns. The steps, the Better Auth calls
 * and the security argument are in `lib/email-change.ts`; refusals answer the constants in
 * `lib/email-change-messages.ts`. Every step charges a per-user limit (fail closed) before Better Auth sees
 * the request, and the current address always comes from the session user, never from the client.
 */

/** Step 1: mail a code to the account's CURRENT address. Also tells its owner a change was asked for. */
export const sendEmailChangeCurrentCodeAction = authenticatedActionClient.action(async ({ ctx }) => {
  assertEmailChangeByCodeAllowed(ctx.user);
  await applyRateLimit(rateLimitConfigs.actions.emailUpdate, ctx.user.id);

  // Server-only endpoint (no route); stores a new code for this address, replacing any earlier one.
  const code = await auth.api.createVerificationOTP({
    body: { email: ctx.user.email, type: "email-verification" },
  });
  const sent = await mailAccountCode({
    to: ctx.user.email,
    code,
    purpose: "confirm_email_change",
    locale: ctx.user.locale,
    userId: ctx.user.id,
  });
  if (!sent) {
    // Logged with its reason by mailAccountCode; the user sees the generic failure.
    throw new Error("Email change code was not sent");
  }

  return { sent: true as const };
});

const ZRequestEmailChangeAction = z.object({ newEmail: ZNewEmailAddress, code: ZAccountCode }).strict();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Step 2: prove the current mailbox and ask for a code at the new address. Better Auth consumes the
 * current-address code (5 wrong guesses burn it) and mails the new address, or sends nothing when another
 * account has it. The answer is the same either way, and padded to the same floor as a sign-in send so
 * its timing does not tell either.
 */
export const requestEmailChangeAction = authenticatedActionClient
  .inputSchema(ZRequestEmailChangeAction)
  .action(async ({ ctx, parsedInput }) => {
    assertEmailChangeByCodeAllowed(ctx.user);
    await applyRateLimit(rateLimitConfigs.actions.emailChangeCode, ctx.user.id);

    const startedAt = Date.now();
    try {
      await auth.api.requestEmailChangeEmailOTP({
        body: { newEmail: parsedInput.newEmail, otp: parsedInput.code },
        headers: await headers(),
      });
    } catch (error) {
      throw toEmailChangeError(error);
    }
    const remaining = EMAIL_CODE_SEND_FLOOR_MS - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);

    return { sent: true as const };
  });

const ZConfirmEmailChangeAction = z.object({ newEmail: ZNewEmailAddress, code: ZAccountCode }).strict();

/** The current session's token, so revoking "every other session" keeps this one. */
const getCurrentSessionToken = async (): Promise<string | undefined> => {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    return session?.session.token;
  } catch {
    return undefined;
  }
};

/**
 * Step 3: prove the new mailbox and change the address. Then sign out every other session and update the
 * CRM copy. Neither of those can undo the change: a failure to revoke is logged at error level and reported
 * as `otherSessionsRevoked: false`, so the user can be told.
 */
export const confirmEmailChangeAction = authenticatedActionClient
  .inputSchema(ZConfirmEmailChangeAction)
  .action(
    withAuditLogging("updated", "user", async ({ ctx, parsedInput }) => {
      assertEmailChangeByCodeAllowed(ctx.user);
      await applyRateLimit(rateLimitConfigs.actions.emailChangeCode, ctx.user.id);

      const oldObject = await getUser(ctx.user.id);
      const keepSessionToken = await getCurrentSessionToken();
      try {
        await auth.api.changeEmailEmailOTP({
          body: { newEmail: parsedInput.newEmail, otp: parsedInput.code },
          headers: await headers(),
        });
      } catch (error) {
        throw toEmailChangeError(error);
      }
      // Always on, whatever the audit-log licence: the change by user id, never the addresses.
      logger.info({ event: "auth_account_email_changed", userId: ctx.user.id }, "Account email changed");

      const otherSessionsRevoked = await revokeOtherSessionsAfterEmailChange({
        userId: ctx.user.id,
        keepSessionToken,
      });

      // A CRM copy with no security role: best-effort (it logs its own failures), never undoes the change.
      try {
        await updateBrevoCustomer({ id: ctx.user.id, email: parsedInput.newEmail });
      } catch {
        logger.error({ userId: ctx.user.id }, "Failed to update Brevo customer after email change");
      }

      ctx.auditLoggingCtx.userId = ctx.user.id;
      ctx.auditLoggingCtx.oldObject = oldObject;
      // Not re-read: `getUser` is request-cached and would return the row as it was before the change.
      ctx.auditLoggingCtx.newObject = oldObject ? { ...oldObject, email: parsedInput.newEmail } : null;

      return { changed: true as const, otherSessionsRevoked };
    })
  );
