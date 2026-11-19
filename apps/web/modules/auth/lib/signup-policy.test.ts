import { beforeEach, describe, expect, test, vi } from "vitest";
import { SIGNUP_DISABLED_ERROR_CODE } from "@formbricks/types/errors";
import { getIsFreshInstance } from "@/lib/instance/service";
import { isSignupDomainAllowed } from "@/modules/auth/lib/signup-request-context";
import { getIsMultiOrgEnabled } from "@/modules/ee/license-check/lib/utils";
import { isUninvitedSignupAllowed, signupPolicyBeforeHandler } from "./signup-policy";

const constantsOverrides = vi.hoisted(() => ({
  SIGNUP_ENABLED: true,
  INITIAL_ADMIN_EMAIL: undefined as string | undefined,
}));
vi.mock("@/lib/constants", () => ({
  get SIGNUP_ENABLED() {
    return constantsOverrides.SIGNUP_ENABLED;
  },
  get INITIAL_ADMIN_EMAIL() {
    return constantsOverrides.INITIAL_ADMIN_EMAIL;
  },
}));
vi.mock("@/lib/instance/service", () => ({ getIsFreshInstance: vi.fn() }));
vi.mock("@/modules/ee/license-check/lib/utils", () => ({ getIsMultiOrgEnabled: vi.fn() }));
vi.mock("@/modules/auth/lib/signup-request-context", () => ({ isSignupDomainAllowed: vi.fn() }));

/** A closed self-hosted instance: SIGNUP_ENABLED is always false there, and it already has users. */
const closeTheInstance = (): void => {
  constantsOverrides.SIGNUP_ENABLED = false;
  vi.mocked(getIsMultiOrgEnabled).mockResolvedValue(false);
  vi.mocked(getIsFreshInstance).mockResolvedValue(false);
};

// A sign-up that did not come through createUserAction (no action mark in the request scope).
const unmarkedSignup = { path: "/sign-up/email" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  constantsOverrides.SIGNUP_ENABLED = true;
  constantsOverrides.INITIAL_ADMIN_EMAIL = undefined;
  vi.mocked(getIsMultiOrgEnabled).mockResolvedValue(true);
  vi.mocked(getIsFreshInstance).mockResolvedValue(false);
  vi.mocked(isSignupDomainAllowed).mockReturnValue(false);
});

describe("isUninvitedSignupAllowed", () => {
  test("allows when public sign-up is genuinely open", async () => {
    await expect(isUninvitedSignupAllowed("admin@example.com")).resolves.toBe(true);
  });

  test("allows the initial administrator on a fresh instance", async () => {
    closeTheInstance();
    vi.mocked(getIsFreshInstance).mockResolvedValue(true);
    await expect(isUninvitedSignupAllowed("admin@example.com")).resolves.toBe(true);
  });

  test("refuses on a closed, already-provisioned instance", async () => {
    closeTheInstance();
    await expect(isUninvitedSignupAllowed("admin@example.com")).resolves.toBe(false);
  });

  test("refuses when SIGNUP_ENABLED is set but the license forbids multiple organizations", async () => {
    vi.mocked(getIsMultiOrgEnabled).mockResolvedValue(false);
    await expect(isUninvitedSignupAllowed("admin@example.com")).resolves.toBe(false);
  });

  // The two orderings below are the reason this predicate short-circuits the way it does: an
  // unauthenticated caller must not be able to make us count the User table on every attempt.
  test("does not count users once public sign-up has answered the question", async () => {
    await expect(isUninvitedSignupAllowed("admin@example.com")).resolves.toBe(true);
    expect(getIsFreshInstance).not.toHaveBeenCalled();
  });

  describe("INITIAL_ADMIN_EMAIL", () => {
    beforeEach(() => {
      closeTheInstance();
      vi.mocked(getIsFreshInstance).mockResolvedValue(true);
      constantsOverrides.INITIAL_ADMIN_EMAIL = "Admin@Example.com";
    });

    test("admits only the configured address on a fresh instance (case-insensitive)", async () => {
      await expect(isUninvitedSignupAllowed(" admin@example.COM ")).resolves.toBe(true);
    });

    test("refuses any other address on a fresh instance, without counting users", async () => {
      await expect(isUninvitedSignupAllowed("first-comer@example.com")).resolves.toBe(false);
      expect(getIsFreshInstance).not.toHaveBeenCalled();
    });

    test("refuses the configured address once the instance has users", async () => {
      vi.mocked(getIsFreshInstance).mockResolvedValue(false);
      await expect(isUninvitedSignupAllowed("admin@example.com")).resolves.toBe(false);
    });

    test("does not restrict open sign-up", async () => {
      constantsOverrides.SIGNUP_ENABLED = true;
      vi.mocked(getIsMultiOrgEnabled).mockResolvedValue(true);
      await expect(isUninvitedSignupAllowed("anyone@example.com")).resolves.toBe(true);
    });
  });

  test("does not consult the license when SIGNUP_ENABLED is false", async () => {
    closeTheInstance();
    await isUninvitedSignupAllowed("admin@example.com");
    expect(getIsMultiOrgEnabled).not.toHaveBeenCalled();
  });
});

describe("signupPolicyBeforeHandler", () => {
  test("rejects a credential sign-up outside the action on a closed instance", async () => {
    closeTheInstance();
    await expect(signupPolicyBeforeHandler(unmarkedSignup)).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: { code: SIGNUP_DISABLED_ERROR_CODE },
    });
  });

  test("ignores every path other than the credential sign-up route", async () => {
    closeTheInstance();
    for (const path of ["/sign-in/email", "/reset-password", "/callback/openid", "/get-session"]) {
      await expect(signupPolicyBeforeHandler({ path } as never)).resolves.toBeUndefined();
    }
  });

  // createUserAction applies the full policy — including the invite exemption this hook cannot see —
  // and marks the request scope. Re-deciding here would reject legitimately invited sign-ups.
  test("exempts a sign-up routed through createUserAction", async () => {
    closeTheInstance();
    vi.mocked(isSignupDomainAllowed).mockReturnValue(true);
    await expect(signupPolicyBeforeHandler(unmarkedSignup)).resolves.toBeUndefined();
    expect(getIsFreshInstance).not.toHaveBeenCalled();
  });

  test("allows a credential sign-up outside the action while the instance is still fresh", async () => {
    closeTheInstance();
    vi.mocked(getIsFreshInstance).mockResolvedValue(true);
    await expect(signupPolicyBeforeHandler(unmarkedSignup)).resolves.toBeUndefined();
  });

  test("allows a credential sign-up outside the action when public sign-up is open", async () => {
    await expect(signupPolicyBeforeHandler(unmarkedSignup)).resolves.toBeUndefined();
  });
});
