import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationNotAllowedError } from "@formbricks/types/errors";
import { disableTwoFactorAuthAction, enableTwoFactorAuthAction, setupTwoFactorAuthAction } from "./actions";
import { disableTwoFactorAuth, enableTwoFactorAuth, setupTwoFactorAuth } from "./lib/two-factor-auth";

const { flags } = vi.hoisted(() => ({ flags: { emailCode: false } }));
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  get EMAIL_CODE_AUTH_ENABLED() {
    return flags.emailCode;
  },
}));
vi.mock("@/lib/utils/action-client", () => ({
  authenticatedActionClient: { inputSchema: vi.fn(() => ({ action: vi.fn((fn) => fn) })) },
}));
vi.mock("@/modules/ee/audit-logs/lib/handler", () => ({
  withAuditLogging: vi.fn((_eventName, _objectType, fn) => fn),
}));
vi.mock("@/modules/ee/license-check/lib/utils", () => ({
  getIsTwoFactorAuthEnabled: vi.fn(async () => true),
}));
vi.mock("./lib/two-factor-auth", () => ({
  setupTwoFactorAuth: vi.fn(async () => ({})),
  enableTwoFactorAuth: vi.fn(async () => ({})),
  disableTwoFactorAuth: vi.fn(async () => ({})),
}));

type TAction = (args: unknown) => Promise<unknown>;
const ctx = () => ({ user: { id: "user-1" }, auditLoggingCtx: {} as Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  flags.emailCode = false;
});

// With email codes there is no password to set 2FA up with, and a code sign-in refuses a 2FA account:
// enabling it would lock the account out.
describe("two-factor enrollment with email-code sign-in on", () => {
  test("setup is refused before anything is generated", async () => {
    flags.emailCode = true;
    await expect(
      (setupTwoFactorAuthAction as unknown as TAction)({ ctx: ctx(), parsedInput: { password: "x" } })
    ).rejects.toThrow(OperationNotAllowedError);
    expect(setupTwoFactorAuth).not.toHaveBeenCalled();
  });

  test("enabling is refused", async () => {
    flags.emailCode = true;
    await expect(
      (enableTwoFactorAuthAction as unknown as TAction)({ ctx: ctx(), parsedInput: { code: "123456" } })
    ).rejects.toThrow(OperationNotAllowedError);
    expect(enableTwoFactorAuth).not.toHaveBeenCalled();
  });

  // An account that already has 2FA (from before the switch) must still be able to drop it.
  test("disabling still works", async () => {
    flags.emailCode = true;
    await (disableTwoFactorAuthAction as unknown as TAction)({
      ctx: ctx(),
      parsedInput: { password: "x", code: "123456" },
    });
    expect(disableTwoFactorAuth).toHaveBeenCalledOnce();
  });
});

describe("two-factor enrollment with email-code sign-in off", () => {
  test("setup and enable work as before", async () => {
    await (setupTwoFactorAuthAction as unknown as TAction)({ ctx: ctx(), parsedInput: { password: "x" } });
    await (enableTwoFactorAuthAction as unknown as TAction)({ ctx: ctx(), parsedInput: { code: "123456" } });
    expect(setupTwoFactorAuth).toHaveBeenCalledWith("user-1", "x");
    expect(enableTwoFactorAuth).toHaveBeenCalledWith("user-1", "123456");
  });
});
