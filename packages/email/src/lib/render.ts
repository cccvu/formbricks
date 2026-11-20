import { render, toPlainText } from "react-email";
import { AccountCodeEmail, type TAccountCodePurpose } from "../../emails/auth/account-code-email";
import { AccountDeletedEmail } from "../../emails/auth/account-deleted-email";
import { DeleteAccountEmail } from "../../emails/auth/delete-account-email";
import { ForgotPasswordEmail } from "../../emails/auth/forgot-password-email";
import { NewEmailVerification } from "../../emails/auth/new-email-verification";
import { PasswordResetNotifyEmail } from "../../emails/auth/password-reset-notify-email";
import { SignInCodeEmail } from "../../emails/auth/sign-in-code-email";
import { SsoRecoveryFactorsRemovedEmail } from "../../emails/auth/sso-recovery-factors-removed-email";
import { SsoSignInHintEmail } from "../../emails/auth/sso-sign-in-hint-email";
import { VerificationEmail } from "../../emails/auth/verification-email";
import { EmailCustomizationPreviewEmail } from "../../emails/general/email-customization-preview-email";
import { InviteAcceptedEmail } from "../../emails/invite/invite-accepted-email";
import { InviteEmail } from "../../emails/invite/invite-email";
import { MemberRetentionNoticeEmail } from "../../emails/retention/member-retention-notice-email";
import {
  SurveyRetentionNoticeEmail,
  type TRetentionNoticeArchivedSurvey,
  type TRetentionNoticeResponseDeletion,
} from "../../emails/retention/survey-retention-notice-email";
import {
  AttachmentExportFailedEmail,
  type TAttachmentExportFailureReason,
} from "../../emails/survey/attachment-export-failed-email";
import { AttachmentExportReadyEmail } from "../../emails/survey/attachment-export-ready-email";
import { EmbedSurveyPreviewEmail } from "../../emails/survey/embed-survey-preview-email";
import { FollowUpEmail, FollowUpEmailProps } from "../../emails/survey/follow-up-email";
import { LinkSurveyEmail } from "../../emails/survey/link-survey-email";
import {
  ResponseFinishedEmail,
  ResponseFinishedEmailProps,
} from "../../emails/survey/response-finished-email";
import { TEmailTemplateLegalProps } from "../types/email";
import { TFunction } from "../types/translations";

export async function renderVerificationEmail(
  props: {
    verifyLink: string;
    verificationRequestLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(VerificationEmail(props));
}

export async function renderForgotPasswordEmail(
  props: {
    verifyLink: string;
    linkValidityInMinutes: number;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(ForgotPasswordEmail(props));
}

export async function renderAccountDeletionEmail(
  props: {
    deleteLink: string;
    linkValidityInMinutes: number;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(DeleteAccountEmail(props));
}

export async function renderNewEmailVerification(
  props: {
    verifyLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(NewEmailVerification(props));
}

export async function renderPasswordResetNotifyEmail(
  props: { t: TFunction } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(PasswordResetNotifyEmail(props));
}

export async function renderAccountDeletedEmail(
  props: { t: TFunction } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(AccountDeletedEmail(props));
}

export async function renderSsoRecoveryFactorsRemovedEmail(
  props: {
    passwordRemoved: boolean;
    twoFactorRemoved: boolean;
    apiKeysRemoved: boolean;
    securitySettingsLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(SsoRecoveryFactorsRemovedEmail(props));
}

export async function renderSsoSignInHintEmail(
  props: {
    providerNames: string[];
    loginLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(SsoSignInHintEmail(props));
}

/**
 * Returns the plain-text part alongside the HTML: a one-time code must stay readable in a client that
 * shows only text, and the text is derived from the same render so the two cannot disagree.
 */
export async function renderSignInCodeEmail(props: {
  code: string;
  validityInMinutes: number;
  t: TFunction;
}): Promise<{ html: string; text: string }> {
  const html = await render(SignInCodeEmail(props));
  return { html, text: toPlainText(html) };
}

/**
 * An account-change code (delete the account, confirm or verify an email change). Like the sign-in code,
 * returns the plain-text part alongside the HTML, both from one render.
 */
export async function renderAccountCodeEmail(props: {
  code: string;
  validityInMinutes: number;
  purpose: TAccountCodePurpose;
  t: TFunction;
}): Promise<{ html: string; text: string }> {
  const html = await render(AccountCodeEmail(props));
  return { html, text: toPlainText(html) };
}

export async function renderSurveyRetentionNoticeEmail(
  props: {
    organizationName: string;
    archivedSurveys: readonly TRetentionNoticeArchivedSurvey[];
    responseDeletions: readonly TRetentionNoticeResponseDeletion[];
    settingsLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(SurveyRetentionNoticeEmail(props));
}

export async function renderMemberRetentionNoticeEmail(
  props: {
    organizationName: string;
    deactivateDate: string;
    loginLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(MemberRetentionNoticeEmail(props));
}

export async function renderAttachmentExportReadyEmail(
  props: {
    surveyName: string;
    archiveSize: string;
    fileCount: string;
    includedFileCount: string;
    sizeLimit: string;
    retentionMonths: string;
    expiryDate: string;
    truncated: boolean;
    downloadLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(AttachmentExportReadyEmail(props));
}

export async function renderAttachmentExportFailedEmail(
  props: {
    surveyName: string;
    reason: TAttachmentExportFailureReason;
    maxFiles: string;
    responsesLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(AttachmentExportFailedEmail(props));
}

export async function renderInviteEmail(
  props: {
    inviteeName: string;
    inviterName: string;
    verifyLink: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(InviteEmail(props));
}

export async function renderInviteAcceptedEmail(
  props: {
    inviterName: string;
    inviteeName: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(InviteAcceptedEmail(props));
}

export async function renderLinkSurveyEmail(
  props: {
    surveyName: string;
    surveyLink: string;
    logoUrl: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(LinkSurveyEmail(props));
}

export async function renderEmbedSurveyPreviewEmail(
  props: {
    html: string;
    workspaceId: string;
    logoUrl?: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(EmbedSurveyPreviewEmail(props));
}

export async function renderResponseFinishedEmail(
  props: ResponseFinishedEmailProps & TEmailTemplateLegalProps
): Promise<string> {
  return await render(ResponseFinishedEmail(props));
}

export async function renderEmailCustomizationPreviewEmail(
  props: {
    userName: string;
    logoUrl?: string;
    t: TFunction;
  } & TEmailTemplateLegalProps
): Promise<string> {
  return await render(EmailCustomizationPreviewEmail(props));
}

export async function renderFollowUpEmail(
  props: FollowUpEmailProps & TEmailTemplateLegalProps
): Promise<string> {
  return await render(FollowUpEmail(props));
}
