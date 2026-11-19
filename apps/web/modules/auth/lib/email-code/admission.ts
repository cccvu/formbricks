import "server-only";
import { prisma } from "@formbricks/database";
import { resolveUninvitedSignupAdmission } from "@/modules/auth/lib/signup-policy";
import { normalizeEmail } from "./tokens";

/**
 * Escapes the LIKE metacharacters (`\`, `%`, `_`). Prisma compiles `equals` + `mode: "insensitive"` to
 * Postgres `ILIKE` without escaping, so an address such as `j_oe@x.com` would otherwise match an invite
 * for `jdoe@x.com`, and `%@x.com` would match every invite on the domain.
 */
export const escapeLikePattern = (value: string): string => value.replaceAll(/[\\%_]/g, String.raw`\$&`);

/**
 * A pending invite is one that has not been accepted (accepting deletes it) and has not expired. Invite
 * addresses are stored as typed, so the match is case-insensitive, but it is an exact match: never a
 * pattern.
 */
export const hasPendingInviteForEmail = async (email: string): Promise<boolean> => {
  const count = await prisma.invite.count({
    where: {
      email: { equals: escapeLikePattern(normalizeEmail(email)), mode: "insensitive" },
      expiresAt: { gt: new Date() },
    },
  });
  return count > 0;
};

/**
 * Whether a sign-in code may be MAILED to this address. Not an authorization decision: the account
 * still has to pass the creation-time backstop and the session gate after the code is proven.
 *
 *  - An existing account: only an active, email-identity account without two-factor auth. SSO accounts
 *    sign in at their IdP; a 2FA account would be refused at session creation anyway.
 *  - No account: a pending invite for this address, or the instance's own uninvited-sign-up policy
 *    (fresh instance + INITIAL_ADMIN_EMAIL, or open sign-up).
 *
 * The User lookup is an exact match on the lowercased address, as Better Auth stores and finds users
 * (`findUserByEmail`), and as `getUserByEmail` does: a case-insensitive match could admit an address
 * that Better Auth's sign-in then does not find.
 */
export const isEmailCodeRecipientAdmitted = async (email: string): Promise<boolean> => {
  const user = await prisma.user.findFirst({
    where: { email: normalizeEmail(email) },
    select: { isActive: true, identityProvider: true, twoFactorEnabled: true },
  });
  if (user) return user.isActive && user.identityProvider === "email" && !user.twoFactorEnabled;
  if (await hasPendingInviteForEmail(email)) return true;
  return (await resolveUninvitedSignupAdmission(email)) !== "denied";
};
