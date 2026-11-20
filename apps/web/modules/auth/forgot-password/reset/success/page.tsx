import { redirect } from "next/navigation";
import { PASSWORD_RESET_DISABLED } from "@/lib/constants";
import { getTranslate } from "@/lingodotdev/server";
import { BackToLoginButton } from "@/modules/auth/components/back-to-login-button";
import { FormWrapper } from "@/modules/auth/components/form-wrapper";

export const ResetPasswordSuccessPage = async () => {
  // With password reset off (always so with email-code sign-in) the reset flow is dead: its actions refuse,
  // so send anyone who lands here, from an old link or a bookmark, to sign in instead.
  if (PASSWORD_RESET_DISABLED) redirect("/auth/login");
  const t = await getTranslate();
  return (
    <FormWrapper>
      <div>
        <h1 className="mb-4 text-center leading-2 font-bold">
          {t("auth.forgot-password.reset.success.heading")}
        </h1>
        <p className="text-center">{t("auth.forgot-password.reset.success.text")}</p>
        <div className="mt-3 text-center">
          <BackToLoginButton />
        </div>
      </div>
    </FormWrapper>
  );
};
