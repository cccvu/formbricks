import { afterEach, describe, expect, test, vi } from "vitest";
import { IdentityProvider } from "@formbricks/database/prisma";
import {
  getAccountDeletionConfirmationMethod,
  requiresPasswordConfirmationForAccountDeletion,
} from "./account-deletion-auth";

const { flags } = vi.hoisted(() => ({ flags: { emailCode: false } }));
vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  get EMAIL_CODE_AUTH_ENABLED() {
    return flags.emailCode;
  },
}));

/**
 * Every value of the Prisma `IdentityProvider` enum, split by which of the two deletion flows it gets:
 * password confirmation, or the emailed link. A provider on the wrong side would hand a password-less
 * account a password prompt it can never satisfy, or send a password-backed account a deletion link
 * instead of asking for its password.
 *
 * The exhaustiveness check below compares against the RUNTIME enum, not the type. Annotating these as
 * `IdentityProvider[]` only rejects values that are not providers — it does not require every provider
 * to appear, so a newly added one would leave both lists type-correct and unclassified.
 */
const PASSWORD_BACKED: IdentityProvider[] = ["email"];
const SSO_ONLY: IdentityProvider[] = ["github", "google", "azuread", "openid", "saml"];

describe("account deletion auth requirements", () => {
  test.each(PASSWORD_BACKED)("requires password confirmation for %s users", (identityProvider) => {
    expect(requiresPasswordConfirmationForAccountDeletion({ identityProvider })).toBe(true);
  });

  test.each(SSO_ONLY)("does not require password confirmation for %s users", (identityProvider) => {
    expect(requiresPasswordConfirmationForAccountDeletion({ identityProvider })).toBe(false);
  });

  test("covers the whole enum, so a newly added provider cannot slip past unclassified", () => {
    const covered = [...PASSWORD_BACKED, ...SSO_ONLY];
    expect(new Set(covered).size).toBe(covered.length); // no provider classified twice
    expect([...covered].sort()).toEqual([...Object.values(IdentityProvider)].sort());
  });
});

describe("getAccountDeletionConfirmationMethod", () => {
  afterEach(() => {
    flags.emailCode = false;
  });

  test.each(PASSWORD_BACKED)("flag off: %s users confirm with their password", (identityProvider) => {
    expect(getAccountDeletionConfirmationMethod({ identityProvider })).toBe("password");
  });

  test.each(SSO_ONLY)("flag off: %s users confirm by emailed link", (identityProvider) => {
    expect(getAccountDeletionConfirmationMethod({ identityProvider })).toBe("email_link");
  });

  // No account has a password with email codes on, SSO accounts included.
  test.each([...PASSWORD_BACKED, ...SSO_ONLY])(
    "flag on: %s users confirm by emailed code, and never by password",
    (identityProvider) => {
      flags.emailCode = true;
      expect(getAccountDeletionConfirmationMethod({ identityProvider })).toBe("email_code");
      expect(requiresPasswordConfirmationForAccountDeletion({ identityProvider })).toBe(false);
    }
  );
});
