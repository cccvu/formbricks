import { redirect } from "next/navigation";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getIsMultiOrgEnabled } from "@/modules/ee/license-check/lib/utils";
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
  SIGNUP_ENABLED: true,
  TERMS_URL: undefined,
  TURNSTILE_SITE_KEY: undefined,
  WEBAPP_URL: "https://app.example.com",
}));
vi.mock("@/lib/jwt", () => ({ verifyInviteToken: vi.fn() }));
vi.mock("@/modules/auth/signup/lib/invite", () => ({ getIsValidInviteToken: vi.fn() }));
vi.mock("@/modules/ee/license-check/lib/utils", () => ({ getIsMultiOrgEnabled: vi.fn() }));
vi.mock("@/modules/ee/sso/lib/sso-availability", () => ({
  getSsoAvailability: vi.fn().mockResolvedValue({}),
  toSsoFormProps: vi.fn().mockReturnValue({}),
}));
vi.mock("@/lib/utils/locale", () => ({ findMatchingLocale: vi.fn().mockResolvedValue("en-US") }));
vi.mock("@/modules/auth/components/form-wrapper", () => ({ FormWrapper: () => null }));
vi.mock("./components/signup-form", () => ({ SignupForm: () => null }));

class RedirectSignal extends Error {}

describe("SignupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.emailCodeAuthEnabled = false;
    vi.mocked(getIsMultiOrgEnabled).mockResolvedValue(true);
    // The real redirect() throws to stop rendering; the global mock is a no-op, so throw here too.
    vi.mocked(redirect).mockImplementation(() => {
      throw new RedirectSignal();
    });
  });

  test("redirects to login with the invite as callbackUrl when email code sign-in is on", async () => {
    flags.emailCodeAuthEnabled = true;

    await expect(
      SignupPage({ searchParams: Promise.resolve({ inviteToken: "tok.en", email: "ada@example.com" }) })
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith(
      "/auth/login?callbackUrl=%2Finvite%3Ftoken%3Dtok.en&email=ada%40example.com"
    );
    expect(getIsMultiOrgEnabled).not.toHaveBeenCalled();
  });

  test("redirects to plain login without an invite when email code sign-in is on", async () => {
    flags.emailCodeAuthEnabled = true;

    await expect(SignupPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith("/auth/login");
  });

  test("renders the sign-up form when email code sign-in is off", async () => {
    await expect(SignupPage({ searchParams: Promise.resolve({}) })).resolves.toBeTruthy();

    expect(redirect).not.toHaveBeenCalled();
  });
});
