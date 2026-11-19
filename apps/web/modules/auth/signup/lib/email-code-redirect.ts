/**
 * With email code sign-in on there is no sign-up form: signing in is the only way in. These build the
 * login URL a sign-up page redirects to, carrying over where the user was headed.
 */

export const SETUP_ORGANIZATION_CREATE_PATH = "/setup/organization/create";

const buildLoginUrl = (params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const queryString = query.toString();
  return queryString ? `/auth/login?${queryString}` : "/auth/login";
};

// `/auth/signup?inviteToken=<t>&email=<e>` → `/auth/login?callbackUrl=%2Finvite%3Ftoken%3D<t>&email=<e>`.
// After signing in, the invite page accepts the invitation, as it does for an existing account.
export const getEmailCodeSignupRedirectUrl = ({
  inviteToken,
  email,
}: {
  inviteToken?: string | null;
  email?: string | null;
}): string =>
  buildLoginUrl({
    callbackUrl: inviteToken
      ? `/invite?${new URLSearchParams({ token: inviteToken }).toString()}`
      : undefined,
    email: email ?? undefined,
  });

// The fresh-instance `/setup/signup` → sign in, then continue setup by creating the organization.
export const getEmailCodeSetupSignupRedirectUrl = (): string =>
  buildLoginUrl({ callbackUrl: SETUP_ORGANIZATION_CREATE_PATH });
