import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@formbricks/database";
import { InvalidInputError, OperationNotAllowedError } from "@formbricks/types/errors";
import { revokeOtherSessionsAfterEmailChange } from "@/app/(app)/workspaces/[workspaceId]/settings/account/profile/lib/email-change";
import {
  SEND_PATH,
  closeRedis,
  cookieHeader,
  createUser,
  flushRedis,
  request,
  seedCode,
  signIn,
  wrongCode,
} from "@/integration/email-code-helpers";
import { resetDb } from "@/integration/reset-db";
import { EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";
import { ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE } from "@/modules/account/constants";
import {
  deleteAccountWithCode,
  requestAccountDeletionCode,
} from "@/modules/account/lib/better-auth-account-deletion-request";
import { auth } from "@/modules/auth/lib/auth";
import { ACCOUNT_CODE_TTL_SECONDS } from "@/modules/auth/lib/email-code/constants";
import { getSession } from "@/modules/auth/lib/session";
import { getIsMultiOrgEnabled } from "@/modules/ee/license-check/lib/utils";
import { type TAccountCodePurpose, sendAccountCodeEmail } from "@/modules/email";

/**
 * Account changes with email-code sign-in (passwordless lifecycle): email change by two codes and
 * account deletion by code. Better Auth's endpoints run exactly as the server actions call them
 * (in-process, session cookie in the headers), against real Postgres and Valkey; over HTTP the same
 * endpoints must not exist.
 */
vi.hoisted(() => {
  process.env.EMAIL_CODE_AUTH_ENABLED = "1";
  process.env.EMAIL_AUTH_DISABLED = "1";
  process.env.PASSWORD_RESET_DISABLED = "1";
  process.env.SES_REGION = "us-east-1";
  process.env.MAIL_FROM = "noreply@example.com";
  process.env.IS_FORMBRICKS_CLOUD = "0";
  process.env.E2E_TESTING = "0";
  process.env.INITIAL_ADMIN_EMAIL = "admin@example.com";
});

const { requestHeaders, cookieSet } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieSet: vi.fn(),
}));

// The server-action context: `headers()` carries the signed-in user's cookie, `cookies()` takes the
// expired auth cookies after a deletion.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => requestHeaders.current),
  cookies: vi.fn(async () => ({ set: cookieSet })),
}));
// The session DAL's `getSession` is React-cached and request-scoped; the deletion request only needs the
// signed-in user's id, so it is stubbed (as in better-auth-account-deletion-request.integration.test.ts).
vi.mock("@/modules/auth/lib/session", () => ({ getSession: vi.fn() }));
vi.mock("@/modules/ee/license-check/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getIsMultiOrgEnabled: vi.fn(),
}));
vi.mock("@/modules/auth/lib/email-code/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/lib/email-code/constants")>()),
  EMAIL_CODE_SEND_FLOOR_MS: 50,
}));

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const NEW_ADDRESS = "fresh@example.com";

/** Signs `email` in by code over HTTP, as the browser does, and returns its cookie header. */
const signInCookie = async (email: string): Promise<string> => {
  const response = await signIn(email, await seedCode(email));
  expect(response.status).toBe(200);
  return cookieHeader(response);
};

const as = (cookie: string) => ({ headers: new Headers({ cookie }) });

const accountMails = (purpose: TAccountCodePurpose) =>
  vi
    .mocked(sendAccountCodeEmail)
    .mock.calls.map(([mail]) => mail)
    .filter((mail) => mail.purpose === purpose);

const lastAccountCode = (purpose: TAccountCodePurpose): string => {
  const mail = accountMails(purpose).at(-1);
  if (!mail) throw new Error(`no ${purpose} code was mailed`);
  return mail.code;
};

/** What the profile action does for step 1: a code for the CURRENT address, minted server-side. */
const currentAddressCode = (email: string): Promise<string> =>
  auth.api.createVerificationOTP({ body: { email, type: "email-verification" } });

const findUser = (email: string) => prisma.user.findUnique({ where: { email } });

/** Spellings a router or proxy might normalize differently from the declared path. */
const spellings = (path: string): string[] => [
  path,
  `/${path}`,
  `${path}/`,
  path.replace(/\/(?=[^/]*$)/, "%2F"),
  path.toUpperCase(),
];

beforeEach(async () => {
  await resetDb();
  await flushRedis();
  vi.clearAllMocks();
  vi.mocked(getIsMultiOrgEnabled).mockResolvedValue(false);
  requestHeaders.current = new Headers();
  await createUser(OWNER);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(closeRedis);

describe("account changes: nothing new is reachable over HTTP", () => {
  test("the flag this file depends on took effect", () => {
    expect(EMAIL_CODE_AUTH_ENABLED).toBe(true);
  });

  test.each([
    ["/email-otp/request-email-change", "POST", { newEmail: NEW_ADDRESS, otp: "12345678" }],
    ["/email-otp/change-email", "POST", { newEmail: NEW_ADDRESS, otp: "12345678" }],
    ["/delete-user", "POST", { token: "12345678" }],
    ["/delete-user", "POST", { password: "Passw0rd!123" }],
    ["/delete-user/callback?token=12345678", "GET", undefined],
    ["/two-factor/enable", "POST", { password: "Passw0rd!123" }],
  ] as const)("%s (%s) answers 404 however it is spelled, even signed in", async (path, method, body) => {
    const cookie = await signInCookie(OWNER);
    const [route, query = ""] = path.split("?");
    for (const spelling of spellings(route)) {
      const response = await request(`${spelling}${query ? `?${query}` : ""}`, body, { method, cookie });
      expect(response.status, `${method} ${spelling}`).toBe(404);
    }
    expect(await findUser(OWNER)).not.toBeNull();
  });

  // The send endpoint is the only code route served. It mints sign-in codes alone, so nothing over HTTP can
  // obtain the email-verification code an email change consumes.
  test("send refuses type email-verification and stores no code", async () => {
    const response = await request(SEND_PATH, { email: OWNER, type: "email-verification" });
    expect(response.status).toBe(400);

    const context = await auth.$context;
    expect(await context.internalAdapter.findVerificationValue(`email-verification-otp-${OWNER}`)).toBeNull();
    expect(sendAccountCodeEmail).not.toHaveBeenCalled();
  });

  test("two-factor endpoints are closed in-process too", async () => {
    const cookie = await signInCookie(OWNER);
    await expect(
      auth.api.enableTwoFactor({ body: { password: "Passw0rd!123" }, ...as(cookie) })
    ).rejects.toMatchObject({ status: "NOT_FOUND" });
  });
});

describe("email change by codes", () => {
  test("needs a session", async () => {
    const otp = await currentAddressCode(OWNER);
    await expect(
      auth.api.requestEmailChangeEmailOTP({ body: { newEmail: NEW_ADDRESS, otp }, headers: new Headers() })
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    await expect(
      auth.api.changeEmailEmailOTP({ body: { newEmail: NEW_ADDRESS, otp }, headers: new Headers() })
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  // A stolen session alone cannot move the account: the current mailbox has to answer first.
  test("a session without the current-address code changes nothing and mails the new address nothing", async () => {
    const cookie = await signInCookie(OWNER);

    await expect(
      auth.api.requestEmailChangeEmailOTP({ body: { newEmail: NEW_ADDRESS }, ...as(cookie) })
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });
    await expect(
      auth.api.requestEmailChangeEmailOTP({ body: { newEmail: NEW_ADDRESS, otp: "12345678" }, ...as(cookie) })
    ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });

    expect(accountMails("verify_new_email")).toEqual([]);
    expect(await findUser(OWNER)).not.toBeNull();
  });

  test("five wrong guesses burn the current-address code: the right one is refused after", async () => {
    const cookie = await signInCookie(OWNER);
    const otp = await currentAddressCode(OWNER);

    for (let i = 0; i < 5; i++) {
      await expect(
        auth.api.requestEmailChangeEmailOTP({
          body: { newEmail: NEW_ADDRESS, otp: wrongCode(otp) },
          ...as(cookie),
        })
      ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    }
    await expect(
      auth.api.requestEmailChangeEmailOTP({ body: { newEmail: NEW_ADDRESS, otp }, ...as(cookie) })
    ).rejects.toMatchObject({ body: { code: "TOO_MANY_ATTEMPTS" } });
    expect(accountMails("verify_new_email")).toEqual([]);
  });

  test("a code minted for another account's address is refused", async () => {
    await createUser(OTHER);
    const otherCode = await currentAddressCode(OTHER);
    const cookie = await signInCookie(OWNER);

    // The current address comes from the session, never from the request.
    await expect(
      auth.api.requestEmailChangeEmailOTP({ body: { newEmail: NEW_ADDRESS, otp: otherCode }, ...as(cookie) })
    ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
  });

  // No enumeration: an address another account has gets the same answer, and no mail at all.
  test("a taken new address answers like a free one and mails nothing", async () => {
    await createUser(OTHER);
    const cookie = await signInCookie(OWNER);

    const taken = await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail: OTHER, otp: await currentAddressCode(OWNER) },
      ...as(cookie),
    });
    expect(accountMails("verify_new_email")).toEqual([]);

    const free = await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail: NEW_ADDRESS, otp: await currentAddressCode(OWNER) },
      ...as(cookie),
    });
    expect(taken).toEqual(free);
    expect(accountMails("verify_new_email").map((mail) => mail.to)).toEqual([NEW_ADDRESS]);

    // Nothing was stored for the taken address either, so no code can complete it.
    await expect(
      auth.api.changeEmailEmailOTP({ body: { newEmail: OTHER, otp: "12345678" }, ...as(cookie) })
    ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    expect(await findUser(OTHER)).not.toBeNull();
    expect(await findUser(OWNER)).not.toBeNull();
  });

  test("the full round trip changes the address, verified, and keeps this session working", async () => {
    const cookie = await signInCookie(OWNER);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });

    await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail: NEW_ADDRESS, otp: await currentAddressCode(OWNER) },
      ...as(cookie),
    });
    const [mail] = accountMails("verify_new_email");
    expect(mail).toMatchObject({ to: NEW_ADDRESS, actorUserId: owner.id });
    expect(mail.code).toMatch(/^\d{8}$/);

    await auth.api.changeEmailEmailOTP({ body: { newEmail: NEW_ADDRESS, otp: mail.code }, ...as(cookie) });

    expect(await prisma.user.findUnique({ where: { id: owner.id } })).toMatchObject({
      email: NEW_ADDRESS,
      emailVerified: true,
    });
    const session = await auth.api.getSession({ ...as(cookie), query: { disableCookieCache: true } });
    expect(session?.user).toMatchObject({ id: owner.id, email: NEW_ADDRESS });

    // Single use: the new-address code cannot be replayed.
    await expect(
      auth.api.changeEmailEmailOTP({ body: { newEmail: NEW_ADDRESS, otp: mail.code }, ...as(cookie) })
    ).rejects.toBeDefined();
  });

  test("another account cannot redeem a new-address code it did not ask for", async () => {
    await createUser(OTHER);
    const ownerCookie = await signInCookie(OWNER);
    const otherCookie = await signInCookie(OTHER);

    await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail: NEW_ADDRESS, otp: await currentAddressCode(OWNER) },
      ...as(ownerCookie),
    });
    const ownersCode = lastAccountCode("verify_new_email");

    await expect(
      auth.api.changeEmailEmailOTP({ body: { newEmail: NEW_ADDRESS, otp: ownersCode }, ...as(otherCookie) })
    ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    expect(await findUser(OTHER)).not.toBeNull();

    // The owner's code was not touched by the attempt.
    await auth.api.changeEmailEmailOTP({
      body: { newEmail: NEW_ADDRESS, otp: ownersCode },
      ...as(ownerCookie),
    });
    expect(await findUser(NEW_ADDRESS)).not.toBeNull();
  });

  test("after the change, every other session is revoked and this one kept", async () => {
    const keptCookie = await signInCookie(OWNER);
    const otherDeviceCookie = await signInCookie(OWNER);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    const kept = await auth.api.getSession(as(keptCookie));
    expect(await prisma.session.count({ where: { userId: owner.id } })).toBe(2);

    await auth.api.requestEmailChangeEmailOTP({
      body: { newEmail: NEW_ADDRESS, otp: await currentAddressCode(OWNER) },
      ...as(keptCookie),
    });
    await auth.api.changeEmailEmailOTP({
      body: { newEmail: NEW_ADDRESS, otp: lastAccountCode("verify_new_email") },
      ...as(keptCookie),
    });

    await expect(
      revokeOtherSessionsAfterEmailChange({ userId: owner.id, keepSessionToken: kept?.session.token })
    ).resolves.toBe(true);

    const sessions = await prisma.session.findMany({ where: { userId: owner.id } });
    expect(sessions.map((session) => session.sessionToken)).toEqual([kept?.session.token]);
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: otherDeviceCookie }),
        query: { disableCookieCache: true },
      })
    ).toBeNull();
  });
});

describe("account deletion by code", () => {
  /** Step 1 as the action runs it for `email`'s user; returns the code that was mailed. */
  const mintDeletionCode = async (email: string): Promise<string> => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    vi.mocked(getSession).mockResolvedValue({ user: { id: user.id, email } } as Awaited<
      ReturnType<typeof getSession>
    >);
    await requestAccountDeletionCode();
    const [mail] = accountMails("delete_account").slice(-1);
    expect(mail).toMatchObject({ to: email, actorUserId: user.id });
    return mail.code;
  };

  /** Step 2 as the action runs it, signed in with `cookie`. */
  const deleteAs = (cookie: string, code: string) => {
    requestHeaders.current = new Headers({ cookie });
    return deleteAccountWithCode(code);
  };

  test("the right code deletes the account and its sessions, and expires the auth cookies", async () => {
    const cookie = await signInCookie(OWNER);
    const code = await mintDeletionCode(OWNER);
    expect(code).toMatch(/^\d{8}$/);

    await deleteAs(cookie, code);

    expect(await findUser(OWNER)).toBeNull();
    expect(await prisma.session.count()).toBe(0);
    expect(cookieSet).toHaveBeenCalledWith(
      expect.stringContaining("session_token"),
      "",
      expect.objectContaining({ maxAge: 0 })
    );
  });

  test("someone else's code is refused, and neither account is deleted", async () => {
    await createUser(OTHER);
    const ownersCode = await mintDeletionCode(OWNER);
    const otherCookie = await signInCookie(OTHER);

    await expect(deleteAs(otherCookie, ownersCode)).rejects.toThrow(InvalidInputError);
    expect(await findUser(OTHER)).not.toBeNull();
    expect(await findUser(OWNER)).not.toBeNull();
  });

  test("an expired code is refused", async () => {
    const cookie = await signInCookie(OWNER);
    const code = await mintDeletionCode(OWNER);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (ACCOUNT_CODE_TTL_SECONDS + 1) * 1000);

    await expect(deleteAs(cookie, code)).rejects.toThrow(InvalidInputError);
    expect(await findUser(OWNER)).not.toBeNull();
  });

  // The code is spent before the sole-owner guard runs, so it cannot be replayed afterwards.
  test("a sole owner is refused with the sole-owner message, and the code cannot be replayed", async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER } });
    const organization = await prisma.organization.create({ data: { name: "Solo Org" } });
    await prisma.membership.create({
      data: { userId: owner.id, organizationId: organization.id, role: "owner", accepted: true },
    });
    const cookie = await signInCookie(OWNER);
    const code = await mintDeletionCode(OWNER);

    const blocked = deleteAs(cookie, code);
    await expect(blocked).rejects.toThrow(OperationNotAllowedError);
    await expect(blocked).rejects.toThrow(ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE);

    await expect(deleteAs(cookie, code)).rejects.toThrow(InvalidInputError);
    expect(await findUser(OWNER)).not.toBeNull();
  });

  test("five parallel uses of the right code delete the account exactly once", async () => {
    const cookie = await signInCookie(OWNER);
    const code = await mintDeletionCode(OWNER);
    requestHeaders.current = new Headers({ cookie });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => deleteAccountWithCode(code)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await findUser(OWNER)).toBeNull();
  });

  // With a real code, so a 404 here cannot be Better Auth's own answer to an unknown token.
  test("the HTTP routes refuse even the right code, without spending it", async () => {
    const cookie = await signInCookie(OWNER);
    const code = await mintDeletionCode(OWNER);

    expect((await request("/delete-user", { token: code }, { cookie })).status).toBe(404);
    expect(
      (await request(`/delete-user/callback?token=${code}`, undefined, { method: "GET", cookie })).status
    ).toBe(404);
    expect(await findUser(OWNER)).not.toBeNull();

    await deleteAs(cookie, code);
    expect(await findUser(OWNER)).toBeNull();
  });
});
