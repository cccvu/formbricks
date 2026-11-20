"use server";

import { z } from "zod";
import { OperationNotAllowedError } from "@formbricks/types/errors";
import { EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";
import { authenticatedActionClient } from "@/lib/utils/action-client";
import { withAuditLogging } from "@/modules/ee/audit-logs/lib/handler";
import { getIsTwoFactorAuthEnabled } from "@/modules/ee/license-check/lib/utils";
import { disableTwoFactorAuth, enableTwoFactorAuth, setupTwoFactorAuth } from "./lib/two-factor-auth";

/**
 * With email-code sign-in on, an account cannot turn two-factor auth on: setting it up needs a password
 * (there is none), and a code sign-in refuses every account that has it, so enabling it would lock the
 * account out. Better Auth's own /two-factor/* endpoints answer 404 under the same flag (email-code guards).
 * Disabling stays available for an account that already has it.
 */
const assertTwoFactorEnrollmentAllowed = (): void => {
  if (EMAIL_CODE_AUTH_ENABLED) {
    throw new OperationNotAllowedError("Two-factor authentication is not available with email-code sign-in");
  }
};

const ZSetupTwoFactorAuthAction = z.object({
  password: z.string(),
});

export const setupTwoFactorAuthAction = authenticatedActionClient
  .inputSchema(ZSetupTwoFactorAuthAction)
  .action(
    withAuditLogging("updated", "twoFactorAuth", async ({ ctx, parsedInput }) => {
      assertTwoFactorEnrollmentAllowed();
      const isTwoFactorAuthEnabled = await getIsTwoFactorAuthEnabled();
      if (!isTwoFactorAuthEnabled) {
        throw new OperationNotAllowedError("Two factor auth is not available on your instance");
      }
      const result = await setupTwoFactorAuth(ctx.user.id, parsedInput.password);
      ctx.auditLoggingCtx.userId = ctx.user.id;
      ctx.auditLoggingCtx.newObject = { twoFactorAuth: "setup" };
      return result;
    })
  );

const ZEnableTwoFactorAuthAction = z.object({
  code: z.string(),
});

export const enableTwoFactorAuthAction = authenticatedActionClient
  .inputSchema(ZEnableTwoFactorAuthAction)
  .action(
    withAuditLogging("updated", "twoFactorAuth", async ({ ctx, parsedInput }) => {
      assertTwoFactorEnrollmentAllowed();
      const isTwoFactorAuthEnabled = await getIsTwoFactorAuthEnabled();
      if (!isTwoFactorAuthEnabled) {
        throw new OperationNotAllowedError("Two factor auth is not available on your instance");
      }
      const result = await enableTwoFactorAuth(ctx.user.id, parsedInput.code);
      ctx.auditLoggingCtx.userId = ctx.user.id;
      ctx.auditLoggingCtx.newObject = { twoFactorAuth: "enabled" };
      return result;
    })
  );

const ZDisableTwoFactorAuthAction = z
  .object({
    code: z.string().optional(),
    password: z.string(),
    backupCode: z.string().optional(),
  })
  .refine(
    (data) => data.password !== undefined || data.code !== undefined,
    "Please provide either the code or the backup code"
  );

export const disableTwoFactorAuthAction = authenticatedActionClient
  .inputSchema(ZDisableTwoFactorAuthAction)
  .action(
    withAuditLogging("updated", "twoFactorAuth", async ({ ctx, parsedInput }) => {
      const result = await disableTwoFactorAuth(ctx.user.id, parsedInput);
      ctx.auditLoggingCtx.userId = ctx.user.id;
      ctx.auditLoggingCtx.newObject = { twoFactorAuth: "disabled" };
      return result;
    })
  );
