import { redirect } from "next/navigation";
import { PASSWORD_RESET_DISABLED } from "@/lib/constants";
import { FormWrapper } from "@/modules/auth/components/form-wrapper";
import { ResetPasswordForm } from "@/modules/auth/forgot-password/reset/components/reset-password-form";

export const ResetPasswordPage = () => {
  // With password reset off (always so with email-code sign-in) the reset flow is dead: its actions refuse,
  // so send anyone who lands here, from an old link or a bookmark, to sign in instead.
  if (PASSWORD_RESET_DISABLED) redirect("/auth/login");
  return (
    <FormWrapper>
      <ResetPasswordForm />
    </FormWrapper>
  );
};
