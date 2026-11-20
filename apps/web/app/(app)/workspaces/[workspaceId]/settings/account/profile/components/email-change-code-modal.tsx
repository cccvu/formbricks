"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { logger } from "@formbricks/logger";
import {
  type TEmailChangeError,
  getEmailChangeError,
} from "@/app/(app)/workspaces/[workspaceId]/settings/account/profile/lib/email-change-error";
import { AccountCodeInput } from "@/modules/auth/components/account-code-input";
import { useResendCooldown } from "@/modules/auth/hooks/use-resend-cooldown";
import {
  ACCOUNT_CODE_RESEND_COOLDOWN_SECONDS,
  ACCOUNT_CODE_TTL_MINUTES,
  isCompleteAccountCode,
} from "@/modules/auth/lib/email-code/account-code-ui";
import { Button } from "@/modules/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/modules/ui/components/dialog";
import {
  confirmEmailChangeAction,
  requestEmailChangeAction,
  sendEmailChangeCurrentCodeAction,
} from "../actions";

type TStep = "start" | "current_code" | "new_code" | "done";

const STEP_NUMBER: Record<Exclude<TStep, "done">, number> = { start: 1, current_code: 2, new_code: 3 };

interface EmailChangeCodeModalProps {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly currentEmail: string;
  readonly newEmail: string;
}

const linkButtonClassName =
  "inline-flex min-h-6 items-center justify-center rounded-sm py-1 text-xs font-semibold text-slate-600 underline hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:outline-hidden disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60";

const reloadProfile = () => globalThis.location.reload();

/**
 * Changes the account's email address with email-code sign-in on, in three steps: a code to the CURRENT
 * address proves the user still holds it; entering it mails a code to the NEW address; entering that one
 * makes the change, and every other session is signed out. The addresses shown come from the profile;
 * the server reads the current one from the session, never from here.
 */
export const EmailChangeCodeModal = ({
  open,
  setOpen,
  currentEmail,
  newEmail,
}: EmailChangeCodeModalProps) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<TStep>("start");
  const [code, setCode] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [otherSessionsRevoked, setOtherSessionsRevoked] = useState(true);
  // Set when a confirm request got no answer: the change may have happened (and spent the code).
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const resendCooldown = useResendCooldown(ACCOUNT_CODE_RESEND_COOLDOWN_SECONDS);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (step === "current_code" || step === "new_code") codeInputRef.current?.focus();
    if (step === "done") doneButtonRef.current?.focus();
  }, [step]);

  const resetState = () => {
    setStep("start");
    setCode("");
    setError(null);
    setStatus(null);
    setIsPending(false);
    setOutcomeUnknown(false);
    resendCooldown.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // After a change, or when it is unclear whether one happened, reload so the profile shows the
      // address the account really has now.
      if (step === "done" || outcomeUnknown) {
        reloadProfile();
        return;
      }
      resetState();
    }
    setOpen(nextOpen);
  };

  // The written-out `t("…")` calls keep each key visible to `scan-translations`.
  const getErrorText = (kind: TEmailChangeError): string => {
    switch (kind) {
      case "invalid_code":
        return t("workspace.settings.profile.account_code_invalid");
      case "email_in_use":
        return t("workspace.settings.profile.email_change_email_in_use");
      case "same_email":
        return t("workspace.settings.profile.email_change_same_email");
      case "rate_limited":
        return t("workspace.settings.profile.account_code_too_many_attempts");
      default:
        return t("common.something_went_wrong_please_try_again");
    }
  };

  const clearMessages = () => {
    setError(null);
    setStatus(null);
  };

  /** Step 1, and "Resend code" in step 2: a code to the current address. */
  const sendCurrentCode = async (): Promise<boolean> => {
    try {
      const result = await sendEmailChangeCurrentCodeAction();
      if (result?.data?.sent) {
        resendCooldown.start();
        return true;
      }
      setError(
        getEmailChangeError(result) === "rate_limited"
          ? t("workspace.settings.profile.account_code_too_many_attempts")
          : t("workspace.settings.profile.account_code_send_failed")
      );
    } catch (sendError) {
      logger.error({ error: sendError }, "Email change code request failed");
      setError(t("workspace.settings.profile.account_code_send_failed"));
    }
    return false;
  };

  const onStart = async () => {
    if (await sendCurrentCode()) {
      setCode("");
      setStep("current_code");
    }
  };

  const onResendCurrentCode = async () => {
    clearMessages();
    setIsResending(true);
    const sent = await sendCurrentCode();
    setIsResending(false);
    if (!sent) return;
    setCode("");
    setStatus(t("workspace.settings.profile.account_code_resent"));
    codeInputRef.current?.focus();
  };

  /** Step 2: the current-address code; the server then mails a code to the new address. */
  const onSubmitCurrentCode = async () => {
    try {
      const result = await requestEmailChangeAction({ newEmail, code });
      if (result?.data?.sent) {
        setCode("");
        setStep("new_code");
        return;
      }
      setError(getErrorText(getEmailChangeError(result)));
    } catch (requestError) {
      logger.error({ error: requestError }, "Email change request failed");
      setError(t("common.something_went_wrong_please_try_again"));
    }
    codeInputRef.current?.focus();
  };

  /** Step 3: the new-address code makes the change. */
  const onSubmitNewCode = async () => {
    let result: Awaited<ReturnType<typeof confirmEmailChangeAction>>;
    try {
      result = await confirmEmailChangeAction({ newEmail, code });
    } catch (confirmError) {
      // No answer: the change may have gone through. A retry with the same code would then be refused.
      logger.error({ error: confirmError }, "Email change confirmation failed");
      setOutcomeUnknown(true);
      setError(t("workspace.settings.profile.email_change_outcome_unknown"));
      codeInputRef.current?.focus();
      return;
    }

    if (result?.data?.changed) {
      setOtherSessionsRevoked(result.data.otherSessionsRevoked);
      setOutcomeUnknown(false);
      setStep("done");
      return;
    }

    const kind = getEmailChangeError(result);
    if (kind === "invalid_code" && outcomeUnknown) {
      // The code was most likely spent by the earlier request that lost its answer: show the real address.
      reloadProfile();
      return;
    }
    setError(getErrorText(kind));
    codeInputRef.current?.focus();
  };

  const onStartOver = () => {
    resetState();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPending) return;
    if (step !== "start" && !isCompleteAccountCode(code)) return;
    clearMessages();
    setIsPending(true);
    try {
      if (step === "start") await onStart();
      else if (step === "current_code") await onSubmitCurrentCode();
      else if (step === "new_code") await onSubmitNewCode();
    } finally {
      setIsPending(false);
    }
  };

  const renderStepBody = () => {
    switch (step) {
      case "start":
        return (
          <p className="text-sm text-slate-700">
            {t("workspace.settings.profile.email_change_intro", { currentEmail, newEmail })}
          </p>
        );
      case "current_code":
        return (
          <>
            <p id="emailChangeCodeHint" className="text-sm text-slate-700">
              {t("workspace.settings.profile.email_change_current_code_sent", {
                email: currentEmail,
                minutes: ACCOUNT_CODE_TTL_MINUTES,
              })}
            </p>
            <AccountCodeInput
              key="current_code"
              ref={codeInputRef}
              id="emailChangeCurrentCode"
              label={t("workspace.settings.profile.email_change_current_code_label")}
              value={code}
              onChange={setCode}
              describedBy="emailChangeCodeHint"
            />
            <button
              type="button"
              className={linkButtonClassName}
              disabled={resendCooldown.seconds > 0 || isResending || isPending}
              onClick={onResendCurrentCode}>
              {resendCooldown.seconds > 0
                ? t("auth.login.email_code.resend_code_in", { seconds: resendCooldown.seconds })
                : t("auth.login.email_code.resend_code")}
            </button>
          </>
        );
      case "new_code":
        return (
          <>
            <p id="emailChangeCodeHint" className="text-sm text-slate-700">
              {t("workspace.settings.profile.email_change_new_code_sent", {
                email: newEmail,
                minutes: ACCOUNT_CODE_TTL_MINUTES,
              })}
            </p>
            <AccountCodeInput
              key="new_code"
              ref={codeInputRef}
              id="emailChangeNewCode"
              label={t("workspace.settings.profile.email_change_new_code_label")}
              value={code}
              onChange={setCode}
              describedBy="emailChangeCodeHint"
            />
            <button type="button" className={linkButtonClassName} disabled={isPending} onClick={onStartOver}>
              {t("workspace.settings.profile.email_change_start_over")}
            </button>
          </>
        );
      case "done":
        return null;
    }
  };

  const getSubmitLabel = () => {
    if (step === "start") return t("auth.login.email_code.send_code");
    if (step === "current_code") return t("common.continue");
    return t("workspace.settings.profile.email_change_confirm");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("workspace.settings.profile.email_change_title")}</DialogTitle>
          <DialogDescription>
            {step === "done"
              ? t("workspace.settings.profile.email_change_done_description")
              : t("workspace.settings.profile.email_change_step", { step: STEP_NUMBER[step], total: 3 })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogBody>
            <div className="space-y-4">
              {step !== "done" && (
                <div className="flex flex-col gap-2 text-sm sm:flex-row sm:justify-between sm:gap-4">
                  <p className="break-all">
                    <strong>{t("auth.email-change.old_email")}:</strong>
                    <br /> {currentEmail}
                  </p>
                  <p className="break-all">
                    <strong>{t("auth.email-change.new_email")}:</strong>
                    <br /> {newEmail}
                  </p>
                </div>
              )}
              {renderStepBody()}
              {/* Persistent live regions: assistive tech only announces changes to regions already in the DOM. */}
              <output aria-live="polite" className="block text-sm text-slate-700">
                {status && <p>{status}</p>}
                {step === "done" && (
                  <p>
                    {otherSessionsRevoked
                      ? t("workspace.settings.profile.email_change_success", { email: newEmail })
                      : t("workspace.settings.profile.email_change_success_sessions_not_revoked", {
                          email: newEmail,
                        })}
                  </p>
                )}
              </output>
              <div role="alert" aria-live="assertive" className="text-sm text-error">
                {error && <p>{error}</p>}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            {step === "done" ? (
              <Button ref={doneButtonRef} type="button" onClick={reloadProfile}>
                {t("common.done")}
              </Button>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  type="submit"
                  loading={isPending}
                  disabled={isPending || (step !== "start" && !isCompleteAccountCode(code))}>
                  {getSubmitLabel()}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
