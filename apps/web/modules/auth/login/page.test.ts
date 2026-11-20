import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import { LoginPage } from "./page";

vi.mock("@/lib/constants", () => ({
  EMAIL_AUTH_ENABLED: false,
  EMAIL_CODE_AUTH_ENABLED: true,
  OIDC_DISPLAY_NAME: undefined,
  PASSWORD_RESET_DISABLED: true,
  SIGNUP_ENABLED: false,
  WEBAPP_URL: "https://app.example.com",
}));
vi.mock("@/modules/ee/license-check/lib/utils", () => ({
  getIsMultiOrgEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/modules/ee/sso/lib/sso-availability", () => ({
  getSsoAvailability: vi.fn().mockResolvedValue({}),
  toSsoFormProps: vi.fn().mockReturnValue({}),
}));
vi.mock("@/modules/auth/components/form-wrapper", () => ({ FormWrapper: () => null }));
vi.mock("./components/login-form", () => ({ LoginForm: () => null }));

const renderLoginFormProps = async (searchParams: Record<string, string>) => {
  const page = (await LoginPage({ searchParams: Promise.resolve(searchParams) })) as ReactElement<{
    children: ReactElement<{ isInviteCallback: boolean }>;
  }>;
  return page.props.children.props;
};

describe("LoginPage invite hint", () => {
  test("flags an invitation callback (/invite with a token)", async () => {
    const props = await renderLoginFormProps({ callbackUrl: "/invite?token=tok.en" });

    expect(props.isInviteCallback).toBe(true);
  });

  test.each([
    ["another path carrying a token", { callbackUrl: "/workspaces?token=tok.en" }],
    ["the invite path without a token", { callbackUrl: "/invite" }],
    ["no callback", {}],
  ])("does not flag %s", async (_, searchParams) => {
    const props = await renderLoginFormProps(searchParams);

    expect(props.isInviteCallback).toBe(false);
  });
});
