import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationNotAllowedError, TooManyRequestsError } from "@formbricks/types/errors";
import { rateLimitConfigs } from "@/modules/core/rate-limit/rate-limit-configs";
import { deleteAccountWithCodeAction, requestAccountDeletionCodeAction } from "./actions";

const mocks = vi.hoisted(() => ({
  flags: { emailCode: true },
  applyRateLimit: vi.fn(),
  requestAccountDeletionCode: vi.fn(),
  deleteAccountWithCode: vi.fn(),
  inputSchemas: [] as unknown[],
}));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  get EMAIL_CODE_AUTH_ENABLED() {
    return mocks.flags.emailCode;
  },
}));
vi.mock("@/lib/utils/action-client", () => ({
  authenticatedActionClient: {
    inputSchema: vi.fn((schema) => {
      mocks.inputSchemas.push(schema);
      return { action: vi.fn((fn) => fn) };
    }),
    action: vi.fn((fn) => fn),
  },
}));
vi.mock("@/modules/core/rate-limit/helpers", () => ({ applyRateLimit: mocks.applyRateLimit }));
vi.mock("@/modules/account/lib/better-auth-account-deletion-request", () => ({
  requestAccountDeletionCode: mocks.requestAccountDeletionCode,
  deleteAccountWithCode: mocks.deleteAccountWithCode,
  requestSsoAccountDeletionEmail: vi.fn(),
}));

type TAction = (args: unknown) => Promise<unknown>;
const ctx = { user: { id: "user-1" }, auditLoggingCtx: {} };
const requestCode = requestAccountDeletionCodeAction as unknown as TAction;
const deleteWithCode = deleteAccountWithCodeAction as unknown as TAction;

/** The zod schema `deleteAccountWithCodeAction` registered (the only `.inputSchema` call in the module). */
const deleteInputSchema = () =>
  mocks.inputSchemas[0] as { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags.emailCode = true;
});
afterEach(() => {
  mocks.flags.emailCode = true;
});

describe("requestAccountDeletionCodeAction", () => {
  test("charges the account-deletion budget, then mints and mails the code", async () => {
    await expect(requestCode({ ctx })).resolves.toEqual({ sent: true });
    expect(mocks.applyRateLimit).toHaveBeenCalledWith(rateLimitConfigs.actions.accountDeletion, "user-1");
    expect(mocks.applyRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestAccountDeletionCode.mock.invocationCallOrder[0]
    );
  });

  test("mints nothing once the budget is spent (or Redis is down: the limit fails closed)", async () => {
    mocks.applyRateLimit.mockRejectedValueOnce(new TooManyRequestsError("Maximum number of requests"));
    await expect(requestCode({ ctx })).rejects.toThrow(TooManyRequestsError);
    expect(mocks.requestAccountDeletionCode).not.toHaveBeenCalled();
  });

  test("is refused when email-code sign-in is off, before spending anything", async () => {
    mocks.flags.emailCode = false;
    await expect(requestCode({ ctx })).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.applyRateLimit).not.toHaveBeenCalled();
    expect(mocks.requestAccountDeletionCode).not.toHaveBeenCalled();
  });
});

describe("deleteAccountWithCodeAction", () => {
  test("charges the per-user attempt budget before trying the code", async () => {
    await expect(deleteWithCode({ ctx, parsedInput: { code: "48207135" } })).resolves.toEqual({
      deleted: true,
    });
    expect(mocks.applyRateLimit).toHaveBeenCalledWith(rateLimitConfigs.actions.accountDeletionCode, "user-1");
    expect(mocks.applyRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteAccountWithCode.mock.invocationCallOrder[0]
    );
    expect(mocks.deleteAccountWithCode).toHaveBeenCalledWith("48207135");
  });

  test("tries no code once the budget is spent", async () => {
    mocks.applyRateLimit.mockRejectedValueOnce(new TooManyRequestsError("Maximum number of requests"));
    await expect(deleteWithCode({ ctx, parsedInput: { code: "48207135" } })).rejects.toThrow(
      TooManyRequestsError
    );
    expect(mocks.deleteAccountWithCode).not.toHaveBeenCalled();
  });

  test("is refused when email-code sign-in is off", async () => {
    mocks.flags.emailCode = false;
    await expect(deleteWithCode({ ctx, parsedInput: { code: "48207135" } })).rejects.toThrow(
      OperationNotAllowedError
    );
    expect(mocks.deleteAccountWithCode).not.toHaveBeenCalled();
  });

  test.each([
    ["48207135", "48207135"],
    ["4820 7135", "48207135"],
    ["4820-7135", "48207135"],
    [" 48207135 ", "48207135"],
  ])("accepts %j as the code %s", (input, expected) => {
    const result = deleteInputSchema().safeParse({ code: input });
    expect(result).toMatchObject({ success: true, data: { code: expected } });
  });

  test.each(["", "1234567", "123456789", "abcdefgh", "4820713a", "1".repeat(40)])(
    "rejects %j before anything runs",
    (input) => {
      expect(deleteInputSchema().safeParse({ code: input }).success).toBe(false);
    }
  );

  test("rejects unknown keys (no password, no token by another name)", () => {
    expect(deleteInputSchema().safeParse({ code: "48207135", password: "x" }).success).toBe(false);
  });
});
