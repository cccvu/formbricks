import "server-only";
import type { User } from "@formbricks/database/prisma";
import { EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";

type TAccountDeletionAuthData = Pick<User, "identityProvider">;

/**
 * How a user confirms deleting their account:
 *  - `email_code` with email-code sign-in on (EMAIL_CODE_AUTH_ENABLED), for every account, SSO included: no
 *    account has a password to confirm with, and the emailed code proves the mailbox just as the link did;
 *  - otherwise upstream's split: `password` for a credential account, `email_link` for an SSO one.
 *
 * The page passes the method to the modal; the server actions and Better Auth's hooks enforce it.
 */
export type TAccountDeletionConfirmationMethod = "password" | "email_link" | "email_code";

export const getAccountDeletionConfirmationMethod = ({
  identityProvider,
}: TAccountDeletionAuthData): TAccountDeletionConfirmationMethod => {
  if (EMAIL_CODE_AUTH_ENABLED) return "email_code";
  return identityProvider === "email" ? "password" : "email_link";
};

export const requiresPasswordConfirmationForAccountDeletion = (user: TAccountDeletionAuthData): boolean =>
  getAccountDeletionConfirmationMethod(user) === "password";
