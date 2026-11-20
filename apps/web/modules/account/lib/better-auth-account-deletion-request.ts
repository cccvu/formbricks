import "server-only";
import { isAPIError } from "better-auth/api";
import { cookies, headers } from "next/headers";
import crypto from "node:crypto";
import { prisma } from "@formbricks/database";
import {
  AuthenticationError,
  AuthorizationError,
  InvalidInputError,
  OperationNotAllowedError,
} from "@formbricks/types/errors";
import type { TUserLocale } from "@formbricks/types/user";
import { EMAIL_CODE_AUTH_ENABLED, WEBAPP_URL } from "@/lib/constants";
import {
  ACCOUNT_DELETED_PATH,
  ACCOUNT_DELETION_INVALID_CODE_MESSAGE,
  ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE,
} from "@/modules/account/constants";
import { requiresPasswordConfirmationForAccountDeletion } from "@/modules/account/lib/account-deletion-auth";
import { auth } from "@/modules/auth/lib/auth";
import { mailAccountCode } from "@/modules/auth/lib/email-code/account-code";
import {
  ACCOUNT_CODE_LENGTH,
  ACCOUNT_CODE_TTL_SECONDS,
  ACCOUNT_DELETION_TOKEN_IDENTIFIER_PREFIX,
} from "@/modules/auth/lib/email-code/constants";
import { getSession } from "@/modules/auth/lib/session";
import { sendDeleteAccountConfirmationEmail } from "@/modules/email";

/**
 * SSO account-deletion email-link request (ENG-1054, design doc §14).
 *
 * Credential users confirm deletion with their password (Better Auth verifies it before the native
 * delete runs). SSO users have no password, so confirmation moves to the inbox: this action mints a
 * `delete-account-<token>` verification value carrying the requester's user id — exactly the shape
 * Better Auth's native `GET /api/auth/delete-user/callback` consumes (it deletes only when the stored
 * value === the session user's id) — and emails the callback link.
 *
 * The global `sendDeleteAccountVerification` is intentionally NOT configured in auth.ts (it would
 * email credential deletions too), so the verification value is minted manually here. Server-only; the
 * DeleteAccountModal calls this for SSO users.
 */

// Matches the manual mint in better-auth-account-deletion.integration.test.ts: a 1-hour window.
const DELETE_ACCOUNT_LINK_VALIDITY_MS = 60 * 60 * 1000;
const DELETE_ACCOUNT_LINK_VALIDITY_MINUTES = DELETE_ACCOUNT_LINK_VALIDITY_MS / (60 * 1000);

export const requestSsoAccountDeletionEmail = async (): Promise<void> => {
  // With email codes on, every account (SSO included) confirms by code instead; a link would be a second
  // way in that bypasses the code action's limits.
  if (EMAIL_CODE_AUTH_ENABLED) {
    throw new OperationNotAllowedError("Confirm account deletion with an emailed code.");
  }

  const session = await getSession();

  if (!session?.user?.id || !session.user.email) {
    throw new AuthenticationError("Not authenticated");
  }

  const userId = session.user.id;
  const email = session.user.email;

  // Resolve the account type + locale up front (the session/BA-callback user carries neither reliably).
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { identityProvider: true, locale: true },
  });
  if (!dbUser) {
    throw new AuthenticationError("Not authenticated");
  }

  // The SSO email-link path is only for password-less SSO users. Credential users (identityProvider
  // "email") must confirm deletion with their password via Better Auth's native delete-user flow.
  // Enforce that here, server-side: this runs behind a directly-callable server action, so the modal's
  // `requiresPasswordConfirmation` UI gating is not a security boundary. Reject before minting a token.
  if (requiresPasswordConfirmationForAccountDeletion(dbUser)) {
    throw new AuthorizationError("Password confirmation is required to delete this account.");
  }

  const locale = (dbUser.locale ?? "en-US") as TUserLocale;

  // A 32-byte (256-bit) secret token: unguessable, and hex keeps it URL-safe for the callback query.
  const token = crypto.randomBytes(32).toString("hex");

  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `delete-account-${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + DELETE_ACCOUNT_LINK_VALIDITY_MS),
  });

  // The callbackURL must be RELATIVE, and must not depend on the deployment. Better Auth runs
  // `originCheck` on the callback GET before it looks at the token, accepting only `trustedOrigins`
  // (BETTER_AUTH_URL / NEXTAUTH_URL) or a relative path — so an absolute, deployment-specific URL here
  // answers INVALID_CALLBACK_URL and the account is never deleted on any host but the one it names.
  // Sending the Cloud offboarding survey URL from here did exactly that everywhere except production
  // Cloud (ENG-3260). The post-deletion page picks the final destination in the browser instead, which
  // is what the credential path in DeleteAccountModal has always done.
  const deleteLink = `${WEBAPP_URL}/api/auth/delete-user/callback?token=${token}&callbackURL=${encodeURIComponent(ACCOUNT_DELETED_PATH)}`;

  await sendDeleteAccountConfirmationEmail({
    actorUserId: userId,
    email,
    locale,
    deleteLink,
    linkValidityInMinutes: DELETE_ACCOUNT_LINK_VALIDITY_MINUTES,
  });
};

/**
 * Account deletion by emailed code (EMAIL_CODE_AUTH_ENABLED), for every account.
 *
 * Better Auth's native delete token, delivered as a code: this mints a `delete-account-<code>` verification
 * value carrying the requester's id, the exact shape `POST /delete-user` with `{ token }` consumes. That
 * path (run in-process by `deleteAccountWithCode` below) consumes the value atomically (single use), deletes
 * only when the stored id is the SESSION user's, and runs the same `beforeDelete` / `afterDelete` as every
 * other deletion (sole-owner guard, organization removal, audit, Brevo).
 *
 * Guessing: 10^8 codes, a victim's live session required, at most `accountDeletion` (5 an hour) live codes
 * and `accountDeletionCode` (10 an hour) attempts per user, 10 minutes each. A new request does not revoke
 * an earlier code; each expires on its own. A guess that matches someone else's live code consumes it (it
 * is then refused, not used), so a stranger can at worst make the owner request another.
 */
const generateAccountDeletionCode = (): string =>
  crypto
    .randomInt(0, 10 ** ACCOUNT_CODE_LENGTH)
    .toString()
    .padStart(ACCOUNT_CODE_LENGTH, "0");

const assertAccountDeletionByCodeEnabled = (): void => {
  if (!EMAIL_CODE_AUTH_ENABLED) {
    throw new OperationNotAllowedError("Account deletion by code is not enabled.");
  }
};

export const requestAccountDeletionCode = async (): Promise<void> => {
  assertAccountDeletionByCodeEnabled();

  const session = await getSession();
  if (!session?.user?.id) {
    throw new AuthenticationError("Not authenticated");
  }
  const userId = session.user.id;

  // The address and locale come from the row, never from the request.
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, locale: true },
  });
  if (!dbUser) {
    throw new AuthenticationError("Not authenticated");
  }

  const code = generateAccountDeletionCode();
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `${ACCOUNT_DELETION_TOKEN_IDENTIFIER_PREFIX}${code}`,
    value: userId,
    expiresAt: new Date(Date.now() + ACCOUNT_CODE_TTL_SECONDS * 1000),
  });

  const sent = await mailAccountCode({
    to: dbUser.email,
    code,
    purpose: "delete_account",
    locale: dbUser.locale,
    userId,
  });
  if (!sent) {
    // Logged with its reason by mailAccountCode. An unexpected error, so the user sees the generic failure.
    throw new Error("Account deletion code was not sent");
  }
};

/** The Better Auth error code on an APIError, if any. */
const getAPIErrorCode = (error: unknown): string | undefined =>
  isAPIError(error) ? (error.body as { code?: unknown } | undefined)?.code?.toString() : undefined;

/**
 * Better Auth's token path deletes the session rows, but the Set-Cookie its inner callback writes never
 * reaches the outer response (`deleteUser` discards the callback's headers), so `nextCookies` has nothing
 * to forward. Expire the auth cookies here, with the attributes they were set with (a `__Host-` cookie is
 * only replaced by one that is Secure, Path=/ and has no Domain).
 */
const expireAuthCookies = async (): Promise<void> => {
  const { authCookies } = await auth.$context;
  const store = await cookies();
  for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken]) {
    store.set(cookie.name, "", { ...cookie.attributes, maxAge: 0 } as Parameters<typeof store.set>[2]);
  }
};

/**
 * Deletes the signed-in user's account with an emailed code, through Better Auth's own `deleteUser`
 * (in-process: the HTTP route answers 404 with email codes on). Maps Better Auth's answers to errors the
 * action client returns verbatim: a wrong, expired, used or foreign code all read the same.
 */
export const deleteAccountWithCode = async (code: string): Promise<void> => {
  assertAccountDeletionByCodeEnabled();

  try {
    await auth.api.deleteUser({ body: { token: code }, headers: await headers() });
  } catch (error) {
    if (isAPIError(error)) {
      if (error.message === ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE) {
        // The code was spent before the guard ran; the user transfers ownership and requests another.
        throw new OperationNotAllowedError(ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE);
      }
      const errorCode = getAPIErrorCode(error);
      if (errorCode === "INVALID_TOKEN") throw new InvalidInputError(ACCOUNT_DELETION_INVALID_CODE_MESSAGE);
      if (error.status === "UNAUTHORIZED" || errorCode === "FAILED_TO_GET_USER_INFO") {
        throw new AuthenticationError("Not authenticated");
      }
    }
    throw error;
  }

  await expireAuthCookies();
};
