"use server";

import { z } from "zod";
import { OperationNotAllowedError } from "@formbricks/types/errors";
import { EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";
import { authenticatedActionClient } from "@/lib/utils/action-client";
import {
  deleteAccountWithCode,
  requestAccountDeletionCode,
  requestSsoAccountDeletionEmail,
} from "@/modules/account/lib/better-auth-account-deletion-request";
import { ZAccountCode } from "@/modules/auth/lib/email-code/account-code-input";
import { applyRateLimit } from "@/modules/core/rate-limit/helpers";
import { rateLimitConfigs } from "@/modules/core/rate-limit/rate-limit-configs";

/**
 * SSO account-deletion email-link request (ENG-1054, design doc §14). Credential users delete via
 * Better Auth's native `authClient.deleteUser({ password })` straight from the modal; SSO users have no
 * password, so confirmation moves to the inbox — this action mints the `delete-account-<token>`
 * verification value and emails Better Auth's `GET /api/auth/delete-user/callback` link. The session
 * gate and the mint itself live in `requestSsoAccountDeletionEmail` (server-only, no args); this
 * wrapper only enforces the shared account-deletion rate limit.
 */
export const requestSsoAccountDeletionEmailAction = authenticatedActionClient.action(async ({ ctx }) => {
  await applyRateLimit(rateLimitConfigs.actions.accountDeletion, ctx.user.id);

  await requestSsoAccountDeletionEmail();

  return { emailSent: true };
});

/**
 * Account deletion by emailed code, with email-code sign-in on (every account, SSO included). Server
 * actions are legacy in this codebase, but these two extend the deletion flow this file already owns.
 *
 * Requesting a code spends the same budget as the email link (`accountDeletion`, 5 an hour); each attempt
 * to use one spends `accountDeletionCode` (10 an hour). Both fail closed, and both are charged before any
 * code is minted or tried.
 */
const assertDeletionByCodeEnabled = (): void => {
  if (!EMAIL_CODE_AUTH_ENABLED) {
    throw new OperationNotAllowedError("Account deletion by code is not enabled.");
  }
};

export const requestAccountDeletionCodeAction = authenticatedActionClient.action(async ({ ctx }) => {
  assertDeletionByCodeEnabled();
  await applyRateLimit(rateLimitConfigs.actions.accountDeletion, ctx.user.id);

  await requestAccountDeletionCode();

  return { sent: true as const };
});

const ZDeleteAccountWithCodeAction = z.object({ code: ZAccountCode }).strict();

/**
 * Deletes the signed-in account with the emailed code. A wrong, expired, used or someone else's code
 * answers `ACCOUNT_DELETION_INVALID_CODE_MESSAGE`; a sole owner gets `ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE`
 * (both in `modules/account/constants.ts`). On success the session is gone and its cookies expired; the
 * client signs out and redirects as after any deletion.
 */
export const deleteAccountWithCodeAction = authenticatedActionClient
  .inputSchema(ZDeleteAccountWithCodeAction)
  .action(async ({ ctx, parsedInput }) => {
    assertDeletionByCodeEnabled();
    await applyRateLimit(rateLimitConfigs.actions.accountDeletionCode, ctx.user.id);

    await deleteAccountWithCode(parsedInput.code);

    return { deleted: true as const };
  });
