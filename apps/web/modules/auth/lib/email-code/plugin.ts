import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { EMAIL_CODE_ALLOWED_ATTEMPTS, EMAIL_CODE_LENGTH, EMAIL_CODE_TTL_SECONDS } from "./constants";
import { emailCodeAfterHandler, emailCodeBeforeHandler, isEmailCodeGuardedPath } from "./guards";
import { sendEmailCodeGated } from "./send";

/** The two endpoints we serve. Everything else the plugin defines is never mounted. */
export const EMAIL_CODE_ENDPOINT_KEYS = ["sendVerificationOTP", "signInEmailOTP"] as const;

export const createEmailOTPBase = () =>
  emailOTP({
    otpLength: EMAIL_CODE_LENGTH,
    expiresIn: EMAIL_CODE_TTL_SECONDS,
    allowedAttempts: EMAIL_CODE_ALLOWED_ATTEMPTS,
    // At rest the code is encrypted with the auth secret, never stored in the clear.
    storeOTP: "encrypted",
    // Every send writes a NEW code with a fresh expiry; "reuse" would extend one code's life on every
    // resend, past the 10-minute limit.
    resendStrategy: "rotate",
    // Sign-in may create the account; the creation-time backstop decides whether it may.
    disableSignUp: false,
    sendVerificationOTP: sendEmailCodeGated,
  });

/**
 * Better Auth's `emailOTP` plugin, cut down to sign-in only.
 *
 * Only `sendVerificationOTP` and `signInEmailOTP` are mounted: the other nine (password reset by code,
 * email change, verification, and the two server-only code readers) have no route and no `auth.api`
 * method, which is stronger than `disabledPaths` (an exact string match on the request path). The
 * plugin's own after-hook (sign-up verification) and `init` are inert with these options, and its
 * rate-limit entries are replaced by `customRules` in auth.ts. `email-code-plugin-contract.test.ts`
 * pins the upstream endpoint list so a better-auth upgrade cannot silently change what this keeps.
 */
export const emailCodePlugin = () => {
  const base = createEmailOTPBase();
  const { sendVerificationOTP, signInEmailOTP } = base.endpoints;
  return {
    id: base.id,
    version: base.version,
    $ERROR_CODES: base.$ERROR_CODES,
    endpoints: { sendVerificationOTP, signInEmailOTP },
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) => isEmailCodeGuardedPath(context.path),
          handler: createAuthMiddleware(emailCodeBeforeHandler),
        },
      ],
      after: [
        {
          matcher: (context: { path?: string }) => isEmailCodeGuardedPath(context.path),
          handler: createAuthMiddleware(emailCodeAfterHandler),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
