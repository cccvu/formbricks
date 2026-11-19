import { redirect } from "next/navigation";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SignupPage } from "./page";

const { flags } = vi.hoisted(() => ({ flags: { emailCodeAuthEnabled: false } }));

vi.mock("@/lib/constants", () => ({
  get EMAIL_CODE_AUTH_ENABLED() {
    return flags.emailCodeAuthEnabled;
  },
  EMAIL_AUTH_ENABLED: true,
  EMAIL_VERIFICATION_DISABLED: false,
  IS_FORMBRICKS_CLOUD: false,
  IS_TURNSTILE_CONFIGURED: false,
  OIDC_DISPLAY_NAME: undefined,
  PRIVACY_URL: undefined,
  TERMS_URL: undefined,
  TURNSTILE_SITE_KEY: undefined,
  WEBAPP_URL: "https://app.example.com",
}));
vi.mock("@/modules/ee/sso/lib/sso-availability", () => ({
  getSsoAvailability: vi.fn().mockResolvedValue({}),
  toSsoFormProps: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/utils/locale", () => ({ findMatchingLocale: vi.fn().mockResolvedValue("en-US") }));
vi.mock("@/lingodotdev/server", () => ({ getTranslate: async () => (key: string) => key }));
vi.mock("@/modules/auth/signup/components/signup-form", () => ({ SignupForm: () => null }));

class RedirectSignal extends Error {}

describe("setup SignupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.emailCodeAuthEnabled = false;
    vi.mocked(redirect).mockImplementation(() => {
      throw new RedirectSignal();
    });
  });

  test("sends the first admin to login, then on to organization creation, when email code sign-in is on", async () => {
    flags.emailCodeAuthEnabled = true;

    await expect(SignupPage()).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith("/auth/login?callbackUrl=%2Fsetup%2Forganization%2Fcreate");
  });

  test("renders the administrator sign-up form when email code sign-in is off", async () => {
    await expect(SignupPage()).resolves.toBeTruthy();

    expect(redirect).not.toHaveBeenCalled();
  });
});
