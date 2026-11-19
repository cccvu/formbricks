import { redirect } from "next/navigation";
import { isValidElement } from "react";
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
vi.mock("@/modules/auth/login/components/email-code-form", () => ({ EmailCodeForm: () => null }));

class RedirectSignal extends Error {}

type TElement = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const findElement = (node: unknown, match: (element: TElement) => boolean): TElement | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as unknown as TElement;
  return match(element) ? element : findElement(element.props.children, match);
};

describe("setup SignupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.emailCodeAuthEnabled = false;
    vi.mocked(redirect).mockImplementation(() => {
      throw new RedirectSignal();
    });
  });

  // Not a redirect to /auth/login: on a fresh instance without multi-org the auth layout sends that page
  // back to /setup/intro, whose button leads here again, so the first admin could never sign in.
  test("renders the code form for the first admin, continuing to organization creation, when email code sign-in is on", async () => {
    flags.emailCodeAuthEnabled = true;

    const page = await SignupPage();

    expect(redirect).not.toHaveBeenCalled();
    const { EmailCodeForm } = await import("@/modules/auth/login/components/email-code-form");
    const found = findElement(page, (element) => element.type === EmailCodeForm);
    expect(found?.props).toEqual({ resolvedCallbackPath: "/setup/organization/create" });
  });

  test("renders the administrator sign-up form when email code sign-in is off", async () => {
    await expect(SignupPage()).resolves.toBeTruthy();

    expect(redirect).not.toHaveBeenCalled();
  });
});
