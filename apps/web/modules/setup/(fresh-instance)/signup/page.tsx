import { Metadata } from "next";
import {
  EMAIL_AUTH_ENABLED,
  EMAIL_CODE_AUTH_ENABLED,
  EMAIL_VERIFICATION_DISABLED,
  IS_FORMBRICKS_CLOUD,
  IS_TURNSTILE_CONFIGURED,
  OIDC_DISPLAY_NAME,
  PRIVACY_URL,
  TERMS_URL,
  TURNSTILE_SITE_KEY,
  WEBAPP_URL,
} from "@/lib/constants";
import { findMatchingLocale } from "@/lib/utils/locale";
import { getTranslate } from "@/lingodotdev/server";
import { EmailCodeForm } from "@/modules/auth/login/components/email-code-form";
import { SignupForm } from "@/modules/auth/signup/components/signup-form";
import { SETUP_ORGANIZATION_CREATE_PATH } from "@/modules/auth/signup/lib/email-code-redirect";
import { getSsoAvailability, toSsoFormProps } from "@/modules/ee/sso/lib/sso-availability";

export const metadata: Metadata = {
  title: "Sign up",
  description: "Open-source Experience Management. Free & open source.",
};

export const SignupPage = async () => {
  const t = await getTranslate();
  const heading = (
    <>
      <h2 className="mb-6 text-xl font-medium">{t("setup.signup.create_administrator")}</h2>
      <p className="text-sm text-slate-800">{t("setup.signup.this_user_has_all_the_power")}</p>
      <hr className="my-6 w-full border-slate-200" />
    </>
  );

  // With email code sign-in the first admin signs in by code right here, then continues setup. Not a
  // redirect to /auth/login: on a fresh instance without multi-org, the auth layout sends that page
  // back to /setup/intro, whose button leads here again.
  if (EMAIL_CODE_AUTH_ENABLED) {
    return (
      <div className="flex w-full flex-col items-center">
        {heading}
        <div className="w-full">
          <EmailCodeForm resolvedCallbackPath={SETUP_ORGANIZATION_CREATE_PATH} />
        </div>
      </div>
    );
  }

  const locale = await findMatchingLocale();

  const ssoAvailability = await getSsoAvailability();

  return (
    <div className="flex flex-col items-center">
      {heading}
      <SignupForm
        webAppUrl={WEBAPP_URL}
        termsUrl={TERMS_URL}
        privacyUrl={PRIVACY_URL}
        emailVerificationDisabled={EMAIL_VERIFICATION_DISABLED}
        emailAuthEnabled={EMAIL_AUTH_ENABLED}
        {...toSsoFormProps(ssoAvailability)}
        oidcDisplayName={OIDC_DISPLAY_NAME}
        userLocale={locale}
        isTurnstileConfigured={IS_TURNSTILE_CONFIGURED}
        turnstileSiteKey={TURNSTILE_SITE_KEY}
        isFormbricksCloud={IS_FORMBRICKS_CLOUD}
      />
    </div>
  );
};
