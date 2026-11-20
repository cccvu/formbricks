"use client";

import { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Trans, useTranslation } from "react-i18next";
import { logger } from "@formbricks/logger";
import { TOrganization } from "@formbricks/types/organizations";
import { TUser } from "@formbricks/types/user";
import { getFormattedErrorMessage } from "@/lib/utils/error-message";
import { ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE } from "@/modules/account/constants";
import type { TAccountDeletionConfirmationMethod } from "@/modules/account/lib/account-deletion-auth";
import {
  type TAccountDeletionCodeError,
  getAccountDeletionCodeError,
} from "@/modules/account/lib/account-deletion-code-error";
import { getPostAccountDeletionRedirectUrl } from "@/modules/account/lib/post-account-deletion-redirect";
import { AccountCodeInput } from "@/modules/auth/components/account-code-input";
import { useResendCooldown } from "@/modules/auth/hooks/use-resend-cooldown";
import { useSignOut } from "@/modules/auth/hooks/use-sign-out";
import { authClient } from "@/modules/auth/lib/auth-client";
import {
  ACCOUNT_CODE_RESEND_COOLDOWN_SECONDS,
  ACCOUNT_CODE_TTL_MINUTES,
  isCompleteAccountCode,
} from "@/modules/auth/lib/email-code/account-code-ui";
import { Alert, AlertDescription, AlertTitle } from "@/modules/ui/components/alert";
import { Button } from "@/modules/ui/components/button";
import { DeleteDialog } from "@/modules/ui/components/delete-dialog";
import { Input } from "@/modules/ui/components/input";
import { PasswordInput } from "@/modules/ui/components/password-input";
import {
  deleteAccountWithCodeAction,
  requestAccountDeletionCodeAction,
  requestSsoAccountDeletionEmailAction,
} from "./actions";

interface DeleteAccountModalProps {
  /** How the user confirms: from `getAccountDeletionConfirmationMethod` on the server. */
  confirmationMethod: TAccountDeletionConfirmationMethod;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  user: TUser;
  isFormbricksCloud: boolean;
  organizationsWithSingleOwner: TOrganization[];
}

const linkButtonClassName =
  "inline-flex min-h-6 items-center justify-center rounded-sm py-1 text-xs font-semibold text-slate-600 underline hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-dark focus-visible:outline-hidden disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60";

export const DeleteAccountModal = ({
  confirmationMethod,
  setOpen,
  open,
  user,
  isFormbricksCloud,
  organizationsWithSingleOwner,
}: Readonly<DeleteAccountModalProps>) => {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [password, setPassword] = useState("");
  const [ssoEmailSent, setSsoEmailSent] = useState(false);
  // Email-code mode (email-code sign-in on): a code mailed to the user's own address confirms the deletion.
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeStatus, setCodeStatus] = useState<string | null>(null);
  const resendCooldown = useResendCooldown(ACCOUNT_CODE_RESEND_COOLDOWN_SECONDS);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const { signOut: signOutWithAudit } = useSignOut({ id: user.id, email: user.email });
  const requiresPasswordConfirmation = confirmationMethod === "password";
  const requiresEmailCode = confirmationMethod === "email_code";

  useEffect(() => {
    if (codeSent) codeInputRef.current?.focus();
  }, [codeSent]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setInputValue("");
      setPassword("");
      setSsoEmailSent(false);
      setCodeSent(false);
      setCode("");
      setCodeError(null);
      setCodeStatus(null);
      resendCooldown.reset();
    }
    setOpen(nextOpen);
  };

  const hasValidEmailConfirmation = inputValue.trim().toLowerCase() === user.email.toLowerCase();
  const hasValidConfirmation =
    hasValidEmailConfirmation &&
    (!requiresPasswordConfirmation || password.length > 0) &&
    (!requiresEmailCode || (codeSent && isCompleteAccountCode(code)));
  const isDeleteDisabled = !hasValidConfirmation || ssoEmailSent;

  // The written-out `t("…")` calls keep each key visible to `scan-translations`.
  const getCodeErrorText = (error: TAccountDeletionCodeError): string => {
    switch (error) {
      case "invalid_code":
        return t("workspace.settings.profile.account_code_invalid");
      case "sole_owner":
        return t("workspace.settings.profile.warning_cannot_delete_account");
      case "rate_limited":
        return t("workspace.settings.profile.account_code_too_many_attempts");
      default:
        return t("common.something_went_wrong_please_try_again");
    }
  };

  // After a deletion the session is already gone (Better Auth deleted it; the code path also expired its
  // cookies). Signing out is then best-effort cleanup of local state, and the redirect always happens.
  const signOutAndRedirect = async () => {
    try {
      await signOutWithAudit({
        clearWorkspaceId: true,
        reason: "account_deletion",
        redirect: false,
      });
    } catch (signOutError) {
      logger.error({ error: signOutError }, "Failed to sign out after account deletion");
    }

    // Same destination, and the same client-side hop, as the SSO email-link path's /auth/account-deleted
    // page — one helper so the two cannot drift apart again (ENG-3260).
    globalThis.location.replace(getPostAccountDeletionRedirectUrl(isFormbricksCloud));
  };

  // Credential users: Better Auth verifies the password, runs the sole-owner guard (beforeDelete), then
  // deletes + cleans up (afterDelete). On success we sign out and redirect exactly as before.
  const deleteCredentialAccount = async () => {
    const { error } = await authClient.deleteUser({ password });

    if (error) {
      if (error.code === "INVALID_PASSWORD") {
        toast.error(t("workspace.settings.profile.wrong_password"));
        return;
      }

      if (error.message === ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE) {
        toast.error(t("workspace.settings.profile.warning_cannot_delete_account"));
        return;
      }

      logger.error({ error }, "Account deletion failed");
      toast.error(error.message ?? t("common.something_went_wrong_please_try_again"));
      return;
    }

    await signOutAndRedirect();
  };

  // SSO users have no password, so deletion is confirmed via an email link. The account is removed only
  // when they click the emailed /api/auth/delete-user/callback link, so we keep the dialog open and show
  // an inline confirmation instead of signing out or redirecting.
  const requestSsoAccountDeletion = async () => {
    const result = await requestSsoAccountDeletionEmailAction();

    if (!result?.data?.emailSent) {
      const fallbackErrorMessage = t("common.something_went_wrong_please_try_again");
      const errorMessage = result ? getFormattedErrorMessage(result) : fallbackErrorMessage;
      logger.error({ errorMessage }, "Account deletion email request failed");
      toast.error(errorMessage || fallbackErrorMessage);
      return;
    }

    setSsoEmailSent(true);
  };

  // Email-code mode, step 1 (and resend): mail a deletion code to the account's own address.
  const sendDeletionCode = async () => {
    if (!hasValidEmailConfirmation || isSendingCode) return;
    setCodeError(null);
    setCodeStatus(null);
    setIsSendingCode(true);
    try {
      const result = await requestAccountDeletionCodeAction();
      if (!result?.data?.sent) {
        const error = getAccountDeletionCodeError(result);
        setCodeError(
          error === "rate_limited"
            ? t("workspace.settings.profile.account_code_too_many_attempts")
            : t("workspace.settings.profile.account_code_send_failed")
        );
        return;
      }
      if (codeSent) {
        setCode("");
        setCodeStatus(t("workspace.settings.profile.account_code_resent"));
        codeInputRef.current?.focus();
      }
      setCodeSent(true);
      resendCooldown.start();
    } catch (error) {
      logger.error({ error }, "Account deletion code request failed");
      setCodeError(t("workspace.settings.profile.account_code_send_failed"));
    } finally {
      setIsSendingCode(false);
    }
  };

  // Email-code mode, step 2: delete with the code. The server checks that the code is this user's.
  const deleteAccountWithCode = async () => {
    setCodeError(null);
    setCodeStatus(null);
    const result = await deleteAccountWithCodeAction({ code });
    if (!result?.data?.deleted) {
      const error = getAccountDeletionCodeError(result);
      if (error === "unknown") logger.error({ errorMessage: result?.serverError }, "Account deletion failed");
      setCodeError(getCodeErrorText(error));
      codeInputRef.current?.focus();
      return;
    }

    await signOutAndRedirect();
  };

  const deleteAccount = async () => {
    try {
      if (!hasValidConfirmation || ssoEmailSent) {
        return;
      }

      setDeleting(true);

      if (requiresEmailCode) {
        await deleteAccountWithCode();
      } else if (requiresPasswordConfirmation) {
        await deleteCredentialAccount();
      } else {
        await requestSsoAccountDeletion();
      }
    } catch (error) {
      logger.error({ error }, "Account deletion failed");
      if (requiresEmailCode) {
        setCodeError(t("common.something_went_wrong_please_try_again"));
      } else {
        toast.error(t("common.something_went_wrong_please_try_again"));
      }
    } finally {
      setDeleting(false);
    }
  };

  const onFormSubmit = async () => {
    if (deleting || isSendingCode) return;
    // In email-code mode, Enter before a code was sent sends one; after that it deletes.
    if (requiresEmailCode && !codeSent) {
      await sendDeletionCode();
      return;
    }
    await deleteAccount();
  };

  return (
    <DeleteDialog
      open={open}
      setOpen={handleOpenChange}
      deleteWhat={t("common.account")}
      onDelete={() => deleteAccount()}
      text={t("workspace.settings.profile.account_deletion_consequences_warning")}
      isDeleting={deleting}
      disabled={isDeleteDisabled}>
      <div className="py-5">
        {ssoEmailSent ? (
          <Alert variant="info">
            <AlertTitle>{t("common.account")}</AlertTitle>
            <AlertDescription>
              {t("workspace.settings.profile.account_deletion_email_sent", { email: user.email })}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <ul className="list-disc pb-6 pl-6">
              <li>
                {t(
                  "workspace.settings.profile.permanent_removal_of_all_of_your_personal_information_and_data"
                )}
              </li>
              {organizationsWithSingleOwner.length > 0 && (
                <li>
                  <Trans
                    i18nKey="workspace.settings.profile.organizations_delete_message"
                    components={{ b: <b /> }}
                  />
                </li>
              )}
              {organizationsWithSingleOwner.length > 0 && (
                <ul className="ml-4" style={{ listStyleType: "circle" }}>
                  {organizationsWithSingleOwner.map((organization) => {
                    if (organization.name) {
                      return <li key={organization.name}>{organization.name}</li>;
                    }
                  })}
                </ul>
              )}
              <li>{t("workspace.settings.profile.warning_cannot_undo")}</li>
            </ul>
            <form
              data-testid="deleteAccountForm"
              onSubmit={async (e) => {
                e.preventDefault();
                await onFormSubmit();
              }}>
              <label htmlFor="deleteAccountConfirmation">
                {t("workspace.settings.profile.please_enter_email_to_confirm_account_deletion", {
                  email: user.email,
                })}
              </label>
              <Input
                data-testid="deleteAccountConfirmation"
                value={inputValue}
                onChange={handleInputChange}
                placeholder={user.email}
                className="mt-2"
                type="text"
                id="deleteAccountConfirmation"
                name="deleteAccountConfirmation"
              />
              {requiresPasswordConfirmation && (
                <>
                  <label htmlFor="deleteAccountPassword" className="mt-4 block">
                    {t("common.password")}
                  </label>
                  <PasswordInput
                    data-testid="deleteAccountPassword"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="pr-10"
                    containerClassName="mt-2"
                    id="deleteAccountPassword"
                    name="deleteAccountPassword"
                    required
                  />
                </>
              )}
              {requiresEmailCode && (
                <div className="mt-4 space-y-3">
                  {/* Persistent live regions: assistive tech only announces changes to regions already in the DOM. */}
                  <output
                    id="deleteAccountCodeStatus"
                    aria-live="polite"
                    className="block text-sm text-slate-600">
                    <p>
                      {codeSent
                        ? t("workspace.settings.profile.delete_account_code_sent", {
                            email: user.email,
                            minutes: ACCOUNT_CODE_TTL_MINUTES,
                          })
                        : t("workspace.settings.profile.delete_account_code_intro", { email: user.email })}
                    </p>
                    {codeStatus && <p className="mt-1">{codeStatus}</p>}
                  </output>
                  <div role="alert" aria-live="assertive" className="text-sm text-error">
                    {codeError && <p>{codeError}</p>}
                  </div>
                  {codeSent ? (
                    <>
                      <AccountCodeInput
                        ref={codeInputRef}
                        id="deleteAccountCode"
                        label={t("workspace.settings.profile.delete_account_code_label")}
                        value={code}
                        onChange={setCode}
                        describedBy="deleteAccountCodeStatus"
                      />
                      <button
                        type="button"
                        className={linkButtonClassName}
                        disabled={resendCooldown.seconds > 0 || isSendingCode || deleting}
                        onClick={sendDeletionCode}>
                        {resendCooldown.seconds > 0
                          ? t("auth.login.email_code.resend_code_in", { seconds: resendCooldown.seconds })
                          : t("auth.login.email_code.resend_code")}
                      </button>
                    </>
                  ) : (
                    <Button
                      type="submit"
                      variant="secondary"
                      size="sm"
                      loading={isSendingCode}
                      disabled={!hasValidEmailConfirmation || isSendingCode}>
                      {t("auth.login.email_code.send_code")}
                    </Button>
                  )}
                </div>
              )}
            </form>
          </>
        )}
      </div>
    </DeleteDialog>
  );
};
