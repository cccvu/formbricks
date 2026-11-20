import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Page from "./page";

const { flags, user } = vi.hoisted(() => ({
  flags: { emailCodeAuthEnabled: false },
  user: { id: "user-1", email: "ada@example.com", identityProvider: "email", twoFactorEnabled: false },
}));

vi.mock("@/lib/constants", () => ({
  get EMAIL_CODE_AUTH_ENABLED() {
    return flags.emailCodeAuthEnabled;
  },
  EMAIL_VERIFICATION_DISABLED: false,
  ENTERPRISE_LICENSE_REQUEST_FORM_URL: "https://example.com/license",
  IS_FORMBRICKS_CLOUD: false,
  PASSWORD_RESET_DISABLED: false,
}));
vi.mock("@/modules/account/lib/account-deletion-auth", () => ({
  getAccountDeletionConfirmationMethod: () => (flags.emailCodeAuthEnabled ? "email_code" : "password"),
}));
vi.mock("@/lingodotdev/server", () => ({ getTranslate: async () => (key: string) => key }));
vi.mock("@/modules/auth/lib/session", () => ({
  getSession: async () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/user/service", () => ({ getUser: async () => user }));
vi.mock("@/lib/organization/service", () => ({ getOrganizationsWhereUserIsSingleOwner: async () => [] }));
vi.mock("@/modules/settings/lib/navigation-data", () => ({ getSettingsLayoutData: async () => null }));
vi.mock("@/modules/ee/license-check/lib/utils", () => ({
  getIsMultiOrgEnabled: async () => false,
  getIsTwoFactorAuthEnabled: async () => true,
}));
vi.mock("@/modules/ee/license-check/lib/license", () => ({
  getEnterpriseLicense: async () => ({ status: "no-license" }),
}));
vi.mock("@/app/(app)/workspaces/[workspaceId]/settings/components/SettingsCard", () => ({
  SettingsCard: ({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("@/app/(app)/workspaces/[workspaceId]/settings/account/profile/components/AccountSecurity", () => ({
  AccountSecurity: () => <div data-testid="account-security" />,
}));
vi.mock(
  "@/app/(app)/workspaces/[workspaceId]/settings/account/profile/components/EditProfileDetailsForm",
  () => ({
    EditProfileDetailsForm: ({ emailCodeAuthEnabled }: Readonly<{ emailCodeAuthEnabled: boolean }>) => (
      <div data-testid="profile-form" data-email-codes={String(emailCodeAuthEnabled)} />
    ),
  })
);
vi.mock("@/app/(app)/workspaces/[workspaceId]/settings/account/profile/components/DeleteAccount", () => ({
  DeleteAccount: ({
    accountDeletionConfirmationMethod,
  }: Readonly<{ accountDeletionConfirmationMethod: string }>) => (
    <div data-testid="delete-account" data-method={accountDeletionConfirmationMethod} />
  ),
}));
vi.mock("@/modules/ee/license-check/components/lite-license-tip", () => ({ LiteLicenseTip: () => null }));
vi.mock("@/modules/ui/components/upgrade-prompt", () => ({ UpgradePrompt: () => null }));
vi.mock("@/modules/ui/components/id-badge", () => ({ IdBadge: () => null }));
vi.mock("@/modules/ui/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/modules/ui/components/page-content-wrapper", () => ({
  PageContentWrapper: ({ children }: Readonly<{ children: React.ReactNode }>) => <main>{children}</main>,
}));

describe("account profile page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.emailCodeAuthEnabled = false;
  });

  test("shows the security card and the password deletion flow without email codes", async () => {
    render(await Page());

    expect(screen.getByRole("region", { name: "common.security" })).toBeInTheDocument();
    expect(screen.getByTestId("account-security")).toBeInTheDocument();
    expect(screen.getByTestId("delete-account")).toHaveAttribute("data-method", "password");
    expect(screen.getByTestId("profile-form")).toHaveAttribute("data-email-codes", "false");
  });

  test("with email codes, hides the security card and confirms deletion by code", async () => {
    flags.emailCodeAuthEnabled = true;

    render(await Page());

    expect(screen.queryByRole("region", { name: "common.security" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-security")).not.toBeInTheDocument();
    expect(screen.getByTestId("delete-account")).toHaveAttribute("data-method", "email_code");
    expect(screen.getByTestId("profile-form")).toHaveAttribute("data-email-codes", "true");
  });
});
