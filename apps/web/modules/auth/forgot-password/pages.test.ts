import { redirect } from "next/navigation";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { EmailSentPage } from "./email-sent/page";
import { ForgotPasswordPage } from "./page";
import { ResetPasswordPage } from "./reset/page";
import { ResetPasswordSuccessPage } from "./reset/success/page";

const { flags } = vi.hoisted(() => ({ flags: { passwordResetDisabled: false } }));

vi.mock("@/lib/constants", () => ({
  get PASSWORD_RESET_DISABLED() {
    return flags.passwordResetDisabled;
  },
}));
vi.mock("@/lingodotdev/server", () => ({ getTranslate: async () => (key: string) => key }));
vi.mock("@/modules/auth/components/form-wrapper", () => ({ FormWrapper: () => null }));
vi.mock("@/modules/auth/components/back-to-login-button", () => ({ BackToLoginButton: () => null }));
vi.mock("@/modules/auth/forgot-password/components/forgot-password-form", () => ({
  ForgotPasswordForm: () => null,
}));
vi.mock("@/modules/auth/forgot-password/reset/components/reset-password-form", () => ({
  ResetPasswordForm: () => null,
}));

class RedirectSignal extends Error {}

const pages = [
  ["/auth/forgot-password", ForgotPasswordPage],
  ["/auth/forgot-password/email-sent", EmailSentPage],
  ["/auth/forgot-password/reset", ResetPasswordPage],
  ["/auth/forgot-password/reset/success", ResetPasswordSuccessPage],
] as const;

describe("forgot-password pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.passwordResetDisabled = false;
    // The real redirect() throws to stop rendering; the global mock is a no-op, so throw here too.
    vi.mocked(redirect).mockImplementation(() => {
      throw new RedirectSignal();
    });
  });

  test.each(pages)("%s redirects to login when password reset is disabled", async (_, Page) => {
    flags.passwordResetDisabled = true;

    await expect(Promise.resolve().then(() => Page())).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirect).toHaveBeenCalledWith("/auth/login");
  });

  test.each(pages)("%s renders when password reset is enabled", async (_, Page) => {
    await expect(Promise.resolve().then(() => Page())).resolves.toBeTruthy();

    expect(redirect).not.toHaveBeenCalled();
  });
});
