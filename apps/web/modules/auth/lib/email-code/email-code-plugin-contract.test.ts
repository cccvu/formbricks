import { emailOTP } from "better-auth/plugins";
import { describe, expect, test } from "vitest";
import {
  EMAIL_CODE_ALLOWED_ATTEMPTS,
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_SEND_PATH,
  EMAIL_CODE_SIGN_IN_PATH,
  EMAIL_CODE_TTL_SECONDS,
} from "./constants";
import { createEmailOTPBase, emailCodePlugin } from "./plugin";

/**
 * Pins what `emailCodePlugin()` keeps from Better Auth's `emailOTP`. The plugin mounts two of the
 * upstream endpoints and relies on the rest of the upstream plugin being inert with our options; a
 * better-auth upgrade that changes either must fail here, not ship silently.
 */
const UPSTREAM_ENDPOINTS = [
  "changeEmailEmailOTP",
  "checkVerificationOTP",
  "createVerificationOTP",
  "forgetPasswordEmailOTP",
  "getVerificationOTP",
  "requestEmailChangeEmailOTP",
  "requestPasswordResetEmailOTP",
  "resetPasswordEmailOTP",
  "sendVerificationOTP",
  "signInEmailOTP",
  "verifyEmailOTP",
];

describe("email-code plugin contract (better-auth emailOTP)", () => {
  test("upstream emailOTP still defines exactly the endpoints plugin.ts was reviewed against", () => {
    const upstream = Object.keys(emailOTP({ sendVerificationOTP: async () => {} }).endpoints).sort();
    expect(
      upstream,
      "better-auth's emailOTP endpoint list changed: re-review modules/auth/lib/email-code/plugin.ts and guards.ts before updating this list"
    ).toEqual(UPSTREAM_ENDPOINTS);
  });

  test("mounts only send and sign-in, at the paths the guards key on", () => {
    const { endpoints } = emailCodePlugin();
    expect(Object.keys(endpoints).sort()).toEqual(["sendVerificationOTP", "signInEmailOTP"]);
    expect(endpoints.sendVerificationOTP.path).toBe(EMAIL_CODE_SEND_PATH);
    expect(endpoints.signInEmailOTP.path).toBe(EMAIL_CODE_SIGN_IN_PATH);
  });

  test("passes the reviewed options to emailOTP", () => {
    expect(createEmailOTPBase().options).toMatchObject({
      otpLength: 8,
      expiresIn: 600,
      allowedAttempts: 5,
      storeOTP: "encrypted",
      resendStrategy: "rotate",
      disableSignUp: false,
    });
    // The constants are the single source the docs and the email copy read from.
    expect([EMAIL_CODE_LENGTH, EMAIL_CODE_TTL_SECONDS, EMAIL_CODE_ALLOWED_ATTEMPTS]).toEqual([8, 600, 5]);
  });

  test("the parts of the base plugin we drop are inert with our options", () => {
    const base = createEmailOTPBase();
    // init only overrides email verification when overrideDefaultEmailVerification is set.
    expect(base.init({} as Parameters<typeof base.init>[0])).toBeUndefined();
    // The sign-up after-hook only fires with sendVerificationOnSignUp.
    const [afterHook] = base.hooks.after;
    expect(afterHook.matcher({ path: "/sign-up/email" } as Parameters<typeof afterHook.matcher>[0])).toBe(
      false
    );
    // And our plugin does not carry the base plugin's own hooks, init or rate-limit rules.
    const plugin = emailCodePlugin() as Record<string, unknown>;
    expect(plugin.init).toBeUndefined();
    expect(plugin.rateLimit).toBeUndefined();
  });
});
