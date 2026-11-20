import { APIError } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "@formbricks/logger";
import {
  InvalidInputError,
  OperationNotAllowedError,
  TooManyRequestsError,
  UniqueConstraintError,
} from "@formbricks/types/errors";
import { rateLimitConfigs } from "@/modules/core/rate-limit/rate-limit-configs";
import {
  confirmEmailChangeAction,
  requestEmailChangeAction,
  resetPasswordAction,
  sendEmailChangeCurrentCodeAction,
  updateUserAction,
} from "./actions";
import {
  EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE,
  EMAIL_CHANGE_INVALID_CODE_MESSAGE,
  EMAIL_CHANGE_SAME_EMAIL_MESSAGE,
} from "./lib/email-change-messages";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
  getIsEmailUnique: vi.fn(),
  verifyUserPassword: vi.fn(),
  applyRateLimit: vi.fn(),
  updateBrevoCustomer: vi.fn(),
  sendVerificationNewEmail: vi.fn(),
  requestPasswordReset: vi.fn(),
  createVerificationOTP: vi.fn(),
  requestEmailChangeEmailOTP: vi.fn(),
  changeEmailEmailOTP: vi.fn(),
  getSession: vi.fn(),
  mailAccountCode: vi.fn(),
  revokeUserSessionsExcept: vi.fn(),
  flags: { emailCode: false },
}));

vi.mock("@/lib/utils/action-client", () => ({
  authenticatedActionClient: {
    inputSchema: vi.fn(() => ({
      action: vi.fn((fn) => fn),
    })),
    // resetPasswordAction in the same module takes no input schema and calls `.action` directly.
    action: vi.fn((fn) => fn),
  },
}));
vi.mock("@/modules/ee/audit-logs/lib/handler", () => ({
  withAuditLogging: vi.fn((_eventName, _objectType, fn) => fn),
}));
vi.mock("@/lib/user/service", () => ({ getUser: mocks.getUser, updateUser: mocks.updateUser }));
vi.mock("@/app/(app)/workspaces/[workspaceId]/settings/account/profile/lib/user", () => ({
  getIsEmailUnique: mocks.getIsEmailUnique,
}));
vi.mock("@/lib/user/password", () => ({ verifyUserPassword: mocks.verifyUserPassword }));
vi.mock("@/modules/core/rate-limit/helpers", () => ({ applyRateLimit: mocks.applyRateLimit }));
vi.mock("@/modules/auth/lib/brevo", () => ({ updateBrevoCustomer: mocks.updateBrevoCustomer }));
vi.mock("@/modules/email", () => ({ sendVerificationNewEmail: mocks.sendVerificationNewEmail }));
vi.mock("@/modules/auth/lib/auth", () => ({
  auth: {
    api: {
      revokeUserSessions: vi.fn(),
      requestPasswordReset: mocks.requestPasswordReset,
      createVerificationOTP: mocks.createVerificationOTP,
      requestEmailChangeEmailOTP: mocks.requestEmailChangeEmailOTP,
      changeEmailEmailOTP: mocks.changeEmailEmailOTP,
      getSession: mocks.getSession,
    },
  },
}));
vi.mock("@/modules/auth/lib/email-code/account-code", () => ({ mailAccountCode: mocks.mailAccountCode }));
vi.mock("@/modules/auth/lib/session-revocation", () => ({
  revokeUserSessionsExcept: mocks.revokeUserSessionsExcept,
}));
vi.mock("@/modules/auth/lib/email-code/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/lib/email-code/constants")>()),
  EMAIL_CODE_SEND_FLOOR_MS: 30,
}));
vi.mock("@formbricks/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
// CI's environment turns password reset and email verification off; these tests are about the paths where
// they are on.
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  PASSWORD_RESET_DISABLED: false,
  EMAIL_VERIFICATION_DISABLED: false,
  get EMAIL_CODE_AUTH_ENABLED() {
    return mocks.flags.emailCode;
  },
}));

const ctxFor = (identityProvider: string, name = "Doe, Jane") => ({
  user: { id: "user-1", name, email: "jane@corp.test", locale: "en-US", identityProvider },
  auditLoggingCtx: {} as Record<string, unknown>,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ id: "user-1", name: "Doe, Jane" });
  mocks.updateUser.mockResolvedValue({ id: "user-1", name: "Doe, Jane" });
});

// The identity provider owns User.name and re-writes it on every sign-in, so the profile form renders
// the input disabled. These cover the server boundary, which is what a crafted request actually meets.
describe("updateUserAction — name is IdP-owned for SSO users", () => {
  test("rejects a name change from an SSO user", async () => {
    await expect(
      (updateUserAction as unknown as (a: unknown) => Promise<unknown>)({
        ctx: ctxFor("azuread"),
        parsedInput: { name: "Jane Doe-Smith" },
      })
    ).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  test("allows a name change from a credential user", async () => {
    await (updateUserAction as unknown as (a: unknown) => Promise<unknown>)({
      ctx: ctxFor("email"),
      parsedInput: { name: "Jane Doe-Smith" },
    });
    expect(mocks.updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ name: "Jane Doe-Smith" })
    );
  });

  test("lets an SSO user submit their unchanged name without erroring", async () => {
    // The form omits untouched fields, but a client echoing the current value back is asking for no
    // change — erroring on that would be a false positive.
    await (updateUserAction as unknown as (a: unknown) => Promise<unknown>)({
      ctx: ctxFor("azuread"),
      parsedInput: { name: "Doe, Jane", locale: "de-DE" },
    });
    expect(mocks.updateUser).toHaveBeenCalledWith("user-1", expect.objectContaining({ locale: "de-DE" }));
  });

  test("still lets an SSO user change their locale", async () => {
    await (updateUserAction as unknown as (a: unknown) => Promise<unknown>)({
      ctx: ctxFor("azuread"),
      parsedInput: { locale: "de-DE" },
    });
    expect(mocks.updateUser).toHaveBeenCalledWith("user-1", { locale: "de-DE" });
  });
});

// The signed-in reset has a budget of its own (ENG-3823): it was the one way to have reset emails sent with no
// limit, and sharing forgot-password's per-account budget would let strangers spend it.
describe("resetPasswordAction — its own reset email budget", () => {
  const reset = resetPasswordAction as unknown as (a: unknown) => Promise<unknown>;

  test("charges the account's reset budget before asking for a reset", async () => {
    await reset({ ctx: ctxFor("email") });

    expect(mocks.applyRateLimit).toHaveBeenCalledWith(
      rateLimitConfigs.actions.passwordResetRequest,
      "user-1"
    );
    expect(mocks.requestPasswordReset).toHaveBeenCalledOnce();
  });

  test("sends nothing once the budget is spent", async () => {
    mocks.applyRateLimit.mockRejectedValueOnce(new TooManyRequestsError("Maximum number of requests"));

    await expect(reset({ ctx: ctxFor("email") })).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled();
  });
});

// A taken address returns quietly, so a capped verification email must too, or the refusal would tell the
// user which addresses are free (ENG-3823).
describe("updateUserAction — a capped email-change email looks like a sent one", () => {
  test("answers the same as for a taken address when the email is rate limited", async () => {
    mocks.verifyUserPassword.mockResolvedValue(true);
    mocks.getIsEmailUnique.mockResolvedValue(true);
    mocks.sendVerificationNewEmail.mockRejectedValueOnce(
      new TooManyRequestsError("Maximum number of requests")
    );

    await expect(
      (updateUserAction as unknown as (a: unknown) => Promise<unknown>)({
        ctx: ctxFor("email"),
        parsedInput: { email: "free@corp.test", password: "secret" },
      })
    ).resolves.toBeDefined();
  });

  test("still reports any other send failure", async () => {
    mocks.verifyUserPassword.mockResolvedValue(true);
    mocks.getIsEmailUnique.mockResolvedValue(true);
    mocks.sendVerificationNewEmail.mockRejectedValueOnce(new Error("smtp down"));

    await expect(
      (updateUserAction as unknown as (a: unknown) => Promise<unknown>)({
        ctx: ctxFor("email"),
        parsedInput: { email: "free@corp.test", password: "secret" },
      })
    ).rejects.toThrow("smtp down");
  });
});

type TAction = (a: unknown) => Promise<unknown>;
const sendCurrentCode = sendEmailChangeCurrentCodeAction as unknown as TAction;
const requestChange = requestEmailChangeAction as unknown as TAction;
const confirmChange = confirmEmailChangeAction as unknown as TAction;
const changeInput = { newEmail: "new@corp.test", code: "48207135" };

describe("updateUserAction — email changes go through the code flow with email-code sign-in on", () => {
  afterEach(() => {
    mocks.flags.emailCode = false;
  });

  test("refuses an email change, without checking a password or spending the budget", async () => {
    mocks.flags.emailCode = true;
    await expect(
      (updateUserAction as unknown as TAction)({
        ctx: ctxFor("email"),
        parsedInput: { email: "new@corp.test", password: "secret" },
      })
    ).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.verifyUserPassword).not.toHaveBeenCalled();
    expect(mocks.applyRateLimit).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  test("still updates the name and locale", async () => {
    mocks.flags.emailCode = true;
    await (updateUserAction as unknown as TAction)({
      ctx: ctxFor("email"),
      parsedInput: { name: "Jane Doe-Smith", locale: "de-DE", email: "jane@corp.test" },
    });
    expect(mocks.updateUser).toHaveBeenCalledWith("user-1", { name: "Jane Doe-Smith", locale: "de-DE" });
  });
});

describe("email change by codes", () => {
  beforeEach(() => {
    mocks.flags.emailCode = true;
    mocks.createVerificationOTP.mockResolvedValue("11223344");
    mocks.mailAccountCode.mockResolvedValue(true);
    mocks.requestEmailChangeEmailOTP.mockResolvedValue({ success: true });
    mocks.changeEmailEmailOTP.mockResolvedValue({ success: true });
    mocks.getSession.mockResolvedValue({ session: { token: "current-token" }, user: { id: "user-1" } });
    mocks.revokeUserSessionsExcept.mockResolvedValue(2);
    mocks.getUser.mockResolvedValue({ id: "user-1", email: "jane@corp.test" });
  });
  afterEach(() => {
    mocks.flags.emailCode = false;
  });

  describe("every step refuses when it must, before spending or sending anything", () => {
    const steps: [string, () => Promise<unknown>, (identityProvider: string) => Promise<unknown>][] = [
      [
        "send current code",
        () => sendCurrentCode({ ctx: ctxFor("email") }),
        (idp) => sendCurrentCode({ ctx: ctxFor(idp) }),
      ],
      [
        "request change",
        () => requestChange({ ctx: ctxFor("email"), parsedInput: changeInput }),
        (idp) => requestChange({ ctx: ctxFor(idp), parsedInput: changeInput }),
      ],
      [
        "confirm change",
        () => confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput }),
        (idp) => confirmChange({ ctx: ctxFor(idp), parsedInput: changeInput }),
      ],
    ];
    const betterAuthCalls = () => [
      mocks.createVerificationOTP,
      mocks.requestEmailChangeEmailOTP,
      mocks.changeEmailEmailOTP,
      mocks.mailAccountCode,
      mocks.applyRateLimit,
    ];

    test.each(steps)("%s: refused with email-code sign-in off", async (_name, run) => {
      mocks.flags.emailCode = false;
      await expect(run()).rejects.toThrow(OperationNotAllowedError);
      for (const call of betterAuthCalls()) expect(call).not.toHaveBeenCalled();
    });

    // The identity provider owns an SSO account's address.
    test.each(steps)("%s: refused for an SSO account", async (_name, _run, runAs) => {
      await expect(runAs("azuread")).rejects.toThrow(OperationNotAllowedError);
      for (const call of betterAuthCalls()) expect(call).not.toHaveBeenCalled();
    });
  });

  describe("sendEmailChangeCurrentCodeAction", () => {
    test("mints the code for the SESSION user's address and mails it there, after charging the budget", async () => {
      await expect(sendCurrentCode({ ctx: ctxFor("email") })).resolves.toEqual({ sent: true });

      expect(mocks.applyRateLimit).toHaveBeenCalledWith(rateLimitConfigs.actions.emailUpdate, "user-1");
      expect(mocks.createVerificationOTP).toHaveBeenCalledWith({
        body: { email: "jane@corp.test", type: "email-verification" },
      });
      expect(mocks.mailAccountCode).toHaveBeenCalledWith({
        to: "jane@corp.test",
        code: "11223344",
        purpose: "confirm_email_change",
        locale: "en-US",
        userId: "user-1",
      });
      expect(mocks.applyRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.createVerificationOTP.mock.invocationCallOrder[0]
      );
    });

    test("ignores any address the client sends", async () => {
      await sendCurrentCode({ ctx: ctxFor("email"), parsedInput: { email: "attacker@evil.test" } });
      expect(mocks.createVerificationOTP).toHaveBeenCalledWith({
        body: { email: "jane@corp.test", type: "email-verification" },
      });
    });

    test("mints nothing once the budget is spent", async () => {
      mocks.applyRateLimit.mockRejectedValueOnce(new TooManyRequestsError("Maximum number of requests"));
      await expect(sendCurrentCode({ ctx: ctxFor("email") })).rejects.toThrow(TooManyRequestsError);
      expect(mocks.createVerificationOTP).not.toHaveBeenCalled();
    });

    test("fails when the mail was not accepted", async () => {
      mocks.mailAccountCode.mockResolvedValue(false);
      await expect(sendCurrentCode({ ctx: ctxFor("email") })).rejects.toThrow();
    });
  });

  describe("requestEmailChangeAction", () => {
    test("hands Better Auth the new address and the current-address code, in-process with the session headers", async () => {
      await expect(requestChange({ ctx: ctxFor("email"), parsedInput: changeInput })).resolves.toEqual({
        sent: true,
      });

      expect(mocks.applyRateLimit).toHaveBeenCalledWith(rateLimitConfigs.actions.emailChangeCode, "user-1");
      expect(mocks.requestEmailChangeEmailOTP).toHaveBeenCalledWith({
        body: { newEmail: "new@corp.test", otp: "48207135" },
        headers: expect.any(Headers),
      });
      expect(mocks.applyRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.requestEmailChangeEmailOTP.mock.invocationCallOrder[0]
      );
    });

    test("pads its answer to the send floor, so a taken address (nothing sent) answers in the same time", async () => {
      const startedAt = Date.now();
      await requestChange({ ctx: ctxFor("email"), parsedInput: changeInput });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30 - 3);
    });

    test("tries nothing once the budget is spent", async () => {
      mocks.applyRateLimit.mockRejectedValueOnce(new TooManyRequestsError("Maximum number of requests"));
      await expect(requestChange({ ctx: ctxFor("email"), parsedInput: changeInput })).rejects.toThrow(
        TooManyRequestsError
      );
      expect(mocks.requestEmailChangeEmailOTP).not.toHaveBeenCalled();
    });

    test.each(["INVALID_OTP", "OTP_EXPIRED", "TOO_MANY_ATTEMPTS"])(
      "answers one invalid-code message for %s",
      async (code) => {
        mocks.requestEmailChangeEmailOTP.mockRejectedValue(
          APIError.from(code === "TOO_MANY_ATTEMPTS" ? "FORBIDDEN" : "BAD_REQUEST", { message: code, code })
        );
        const failure = requestChange({ ctx: ctxFor("email"), parsedInput: changeInput });
        await expect(failure).rejects.toThrow(InvalidInputError);
        await expect(failure).rejects.toThrow(EMAIL_CHANGE_INVALID_CODE_MESSAGE);
      }
    );

    test("answers the same-address message", async () => {
      mocks.requestEmailChangeEmailOTP.mockRejectedValue(
        APIError.fromStatus("BAD_REQUEST", { message: "Email is the same" })
      );
      await expect(requestChange({ ctx: ctxFor("email"), parsedInput: changeInput })).rejects.toThrow(
        EMAIL_CHANGE_SAME_EMAIL_MESSAGE
      );
    });
  });

  describe("confirmEmailChangeAction", () => {
    test("changes the address, logs it by user id only, keeps this session and signs out the others", async () => {
      await expect(confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput })).resolves.toEqual({
        changed: true,
        otherSessionsRevoked: true,
      });

      expect(mocks.applyRateLimit).toHaveBeenCalledWith(rateLimitConfigs.actions.emailChangeCode, "user-1");
      expect(mocks.changeEmailEmailOTP).toHaveBeenCalledWith({
        body: { newEmail: "new@corp.test", otp: "48207135" },
        headers: expect.any(Headers),
      });
      expect(mocks.revokeUserSessionsExcept).toHaveBeenCalledExactlyOnceWith({
        userId: "user-1",
        keepSessionToken: "current-token",
      });
      expect(mocks.updateBrevoCustomer).toHaveBeenCalledWith({ id: "user-1", email: "new@corp.test" });
      expect(logger.info).toHaveBeenCalledWith(
        { event: "auth_account_email_changed", userId: "user-1" },
        expect.any(String)
      );
      expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("corp.test");
    });

    test("records the change for the audit log", async () => {
      const ctx = ctxFor("email");
      await confirmChange({ ctx, parsedInput: changeInput });
      expect(ctx.auditLoggingCtx).toMatchObject({
        userId: "user-1",
        oldObject: { email: "jane@corp.test" },
        newObject: { email: "new@corp.test" },
      });
    });

    test("retries the revocation once, then reports it", async () => {
      mocks.revokeUserSessionsExcept.mockRejectedValueOnce(new Error("redis")).mockResolvedValueOnce(1);
      await expect(confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput })).resolves.toEqual({
        changed: true,
        otherSessionsRevoked: true,
      });
      expect(mocks.revokeUserSessionsExcept).toHaveBeenCalledTimes(2);
    });

    test("when revocation keeps failing, the change stands, the failure is logged at error and returned", async () => {
      mocks.revokeUserSessionsExcept.mockRejectedValue(new Error("redis"));
      await expect(confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput })).resolves.toEqual({
        changed: true,
        otherSessionsRevoked: false,
      });
      expect(mocks.revokeUserSessionsExcept).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "auth_account_email_change_revoke_failed", userId: "user-1" }),
        expect.any(String)
      );
    });

    // "Everyone but this session" without knowing this session would sign the user out too.
    test("revokes nothing when the current session token is unknown, and reports it", async () => {
      mocks.getSession.mockResolvedValue(null);
      await expect(confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput })).resolves.toEqual({
        changed: true,
        otherSessionsRevoked: false,
      });
      expect(mocks.revokeUserSessionsExcept).not.toHaveBeenCalled();
    });

    test("answers the in-use message only Better Auth gives after a valid new-address code", async () => {
      mocks.changeEmailEmailOTP.mockRejectedValue(
        APIError.fromStatus("BAD_REQUEST", { message: "Email already in use" })
      );
      const failure = confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput });
      await expect(failure).rejects.toThrow(UniqueConstraintError);
      await expect(failure).rejects.toThrow(EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE);
      expect(mocks.revokeUserSessionsExcept).not.toHaveBeenCalled();
    });

    test("a wrong code changes nothing and signs nobody out", async () => {
      mocks.changeEmailEmailOTP.mockRejectedValue(
        APIError.from("BAD_REQUEST", { message: "Invalid OTP", code: "INVALID_OTP" })
      );
      await expect(confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput })).rejects.toThrow(
        EMAIL_CHANGE_INVALID_CODE_MESSAGE
      );
      expect(mocks.revokeUserSessionsExcept).not.toHaveBeenCalled();
      expect(mocks.updateBrevoCustomer).not.toHaveBeenCalled();
    });

    test("tries nothing once the budget is spent", async () => {
      mocks.applyRateLimit.mockRejectedValueOnce(new TooManyRequestsError("Maximum number of requests"));
      await expect(confirmChange({ ctx: ctxFor("email"), parsedInput: changeInput })).rejects.toThrow(
        TooManyRequestsError
      );
      expect(mocks.changeEmailEmailOTP).not.toHaveBeenCalled();
    });
  });
});
