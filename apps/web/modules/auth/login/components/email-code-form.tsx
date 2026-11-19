"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import { FormProvider, SubmitHandler, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { FORMBRICKS_LOGGED_IN_WITH_LS } from "@/lib/localStorage";
import { authClient } from "@/modules/auth/lib/auth-client";
import { EMAIL_CODE_LENGTH } from "@/modules/auth/lib/email-code/constants";
import { Button } from "@/modules/ui/components/button";
import { FormControl, FormError, FormField, FormItem, FormLabel } from "@/modules/ui/components/form";
import { Input } from "@/modules/ui/components/input";

export const EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60;

const ZEmailStep = z.object({ email: z.email() });
type TEmailStep = z.infer<typeof ZEmailStep>;

const ZCodeStep = z.object({ code: z.string().regex(new RegExp(String.raw`^\d{${EMAIL_CODE_LENGTH}}$`)) });
type TCodeStep = z.infer<typeof ZCodeStep>;

// People paste codes as "1234 5678" or "1234-5678"; only the digits matter.
const normalizeCode = (value: string) => value.replace(/[\s-]/g, "");

type TAuthClientError = { status?: number } | null | undefined;
const isRateLimited = (error: TAuthClientError) => error?.status === 429;

interface EmailCodeFormProps {
  prefilledEmail?: string;
  resolvedCallbackPath: string;
}

/**
 * Passwordless sign-in: the server mails a one-time code, the user types it back. Every message here
 * is worded so it never confirms whether an account exists for the address: sending always "succeeds",
 * and any rejected code gets the same generic error.
 */
export const EmailCodeForm = ({ prefilledEmail, resolvedCallbackPath }: Readonly<EmailCodeFormProps>) => {
  const router = useRouter();
  const { t } = useTranslation();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"email" | "code">("email");
  const [sentToEmail, setSentToEmail] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);

  const emailForm = useForm<TEmailStep>({
    defaultValues: { email: prefilledEmail ?? "" },
    resolver: zodResolver(ZEmailStep),
  });
  const codeForm = useForm<TCodeStep>({
    defaultValues: { code: "" },
    resolver: zodResolver(ZCodeStep),
  });

  useEffect(() => {
    if (cooldown <= 0) return;
    const timeout = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timeout);
  }, [cooldown]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const sendCode = async (email: string): Promise<boolean> => {
    try {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      if (error) {
        setServerError(
          isRateLimited(error)
            ? t("auth.login.email_code.too_many_attempts")
            : t("auth.login.email_code.send_failed")
        );
        return false;
      }
      return true;
    } catch {
      setServerError(t("auth.login.email_code.send_failed"));
      return false;
    }
  };

  const onEmailSubmit: SubmitHandler<TEmailStep> = async ({ email }) => {
    setServerError(null);
    setStatusMessage(null);
    const normalizedEmail = email.trim().toLowerCase();
    if (!(await sendCode(normalizedEmail))) return;

    setSentToEmail(normalizedEmail);
    codeForm.reset({ code: "" });
    setCooldown(EMAIL_CODE_RESEND_COOLDOWN_SECONDS);
    setStep("code");
  };

  const onCodeSubmit: SubmitHandler<TCodeStep> = async ({ code }) => {
    setServerError(null);
    setStatusMessage(null);
    try {
      const { error } = await authClient.signIn.emailOtp({ email: sentToEmail, otp: code });
      if (error) {
        setServerError(
          isRateLimited(error)
            ? t("auth.login.email_code.too_many_attempts")
            : t("auth.login.email_code.invalid_code")
        );
        return;
      }
    } catch {
      setServerError(t("auth.login.email_code.invalid_code"));
      return;
    }

    if (typeof window !== "undefined") {
      localStorage.setItem(FORMBRICKS_LOGGED_IN_WITH_LS, "Email");
    }
    // Keep the button busy until the navigation replaces this page.
    setIsNavigating(true);
    router.push(resolvedCallbackPath || "/");
  };

  const onResend = async () => {
    setServerError(null);
    setStatusMessage(null);
    setIsResending(true);
    const sent = await sendCode(sentToEmail);
    setIsResending(false);
    if (!sent) return;

    codeForm.reset({ code: "" });
    setCooldown(EMAIL_CODE_RESEND_COOLDOWN_SECONDS);
    setStatusMessage(t("auth.login.email_code.code_resent"));
    codeRef.current?.focus();
  };

  const onUseDifferentEmail = () => {
    setServerError(null);
    setStatusMessage(null);
    setStep("email");
    setTimeout(() => emailRef.current?.focus(), 0);
  };

  const onCodePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    // `maxLength` would cut "1234 5678" to "1234 567" before onChange sees it, so normalize the paste here.
    event.preventDefault();
    const pasted = normalizeCode(event.clipboardData.getData("text")).slice(0, EMAIL_CODE_LENGTH);
    codeForm.setValue("code", pasted, { shouldDirty: true });
  };

  const linkButtonClassName =
    "inline-flex min-h-6 items-center justify-center rounded-sm py-1 text-xs font-semibold text-slate-600 underline hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:outline-hidden disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60";

  return (
    <div className="space-y-2">
      {/* Persistent live regions: assistive tech only announces changes to regions already in the DOM. */}
      <output aria-live="polite" className="block text-left text-sm text-slate-600">
        {step === "code" && <p>{t("auth.login.email_code.code_sent_description", { email: sentToEmail })}</p>}
        {statusMessage && <p className="mt-1">{statusMessage}</p>}
      </output>
      <div role="alert" aria-live="assertive" className="text-left text-sm text-error">
        {serverError && <p>{serverError}</p>}
      </div>

      {/* Keyed so React mounts a fresh field per step instead of reusing the email field's controller. */}
      {step === "email" ? (
        <FormProvider key="email" {...emailForm}>
          <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-2">
            <FormField
              control={emailForm.control}
              name="email"
              render={({ field }) => (
                <FormItem className="w-full text-left">
                  <FormLabel>{t("common.email")}</FormLabel>
                  <FormControl>
                    <Input
                      ref={emailRef}
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                      name={field.name}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event)}
                      placeholder="work@email.com"
                    />
                  </FormControl>
                  <FormError role="alert" />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="h-11 w-full min-w-0 justify-center sm:h-9"
              loading={emailForm.formState.isSubmitting}>
              {t("auth.login.email_code.send_code")}
            </Button>
          </form>
        </FormProvider>
      ) : (
        <FormProvider key="code" {...codeForm}>
          <form onSubmit={codeForm.handleSubmit(onCodeSubmit)} className="space-y-2">
            <FormField
              control={codeForm.control}
              name="code"
              render={({ field }) => (
                <FormItem className="w-full text-left">
                  <FormLabel>{t("auth.login.email_code.code_label")}</FormLabel>
                  <FormControl>
                    <Input
                      ref={codeRef}
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern={String.raw`\d{${EMAIL_CODE_LENGTH}}`}
                      maxLength={EMAIL_CODE_LENGTH}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                      name={field.name}
                      value={field.value}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(normalizeCode(event.target.value))}
                      onPaste={onCodePaste}
                      className="tracking-widest"
                    />
                  </FormControl>
                  <FormError role="alert">
                    {codeForm.formState.errors.code ? t("auth.login.email_code.code_format") : undefined}
                  </FormError>
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="h-11 w-full min-w-0 justify-center sm:h-9"
              loading={codeForm.formState.isSubmitting || isNavigating}>
              {t("auth.login.email_code.sign_in")}
            </Button>
          </form>
          <div className="flex flex-col items-center gap-1 pt-2">
            <button
              type="button"
              className={linkButtonClassName}
              disabled={cooldown > 0 || isResending}
              onClick={onResend}>
              {cooldown > 0
                ? t("auth.login.email_code.resend_code_in", { seconds: cooldown })
                : t("auth.login.email_code.resend_code")}
            </button>
            <button type="button" className={linkButtonClassName} onClick={onUseDifferentEmail}>
              {t("auth.login.email_code.use_a_different_email")}
            </button>
          </div>
        </FormProvider>
      )}
    </div>
  );
};
