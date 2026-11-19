import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@formbricks/database";
import { BootstrapAdminMarker } from "@formbricks/database/prisma";
import {
  INVALID_OTP,
  SIGN_IN_PATH,
  closeRedis,
  createInvite,
  createUser,
  flushRedis,
  hasSessionCookie,
  lastMailedCode,
  request,
  seedCode,
  sendCode,
  signIn,
  snapshot,
} from "@/integration/email-code-helpers";
import { resetDb } from "@/integration/reset-db";
import { INITIAL_ADMIN_EMAIL, SIGNUP_ENABLED } from "@/lib/constants";
import { sendSignInCodeEmail } from "@/modules/email";

/**
 * Email-code sign-in, who gets an account and who gets a session. A proven code is necessary but
 * never sufficient: the instance's sign-up policy decides creation, and the session gate refuses
 * account types a mailbox code must not sign in (2FA, SSO, deactivated).
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

vi.mock("@/modules/auth/lib/email-code/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/lib/email-code/constants")>()),
  EMAIL_CODE_SEND_FLOOR_MS: 50,
}));

const findUser = (email: string) => prisma.user.findUnique({ where: { email } });

/** A refusal: no account-creation 500, and no session. */
const expectRefused = async (response: Response) => {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(hasSessionCookie(response)).toBe(false);
};

beforeEach(async () => {
  await resetDb();
  await flushRedis();
  vi.clearAllMocks();
});

afterAll(closeRedis);

describe("email-code sign-in: account creation", () => {
  test("this file runs a closed instance with INITIAL_ADMIN_EMAIL set", () => {
    expect(SIGNUP_ENABLED).toBe(false);
    expect(INITIAL_ADMIN_EMAIL).toBe("admin@example.com");
  });

  test("closed instance: an unknown address gets no mail, and even a valid code creates no account", async () => {
    await createUser("existing@example.com");

    expect((await sendCode("stranger@example.com")).status).toBe(200);
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();

    const otp = await seedCode("stranger@example.com");
    await expectRefused(await signIn("stranger@example.com", otp));
    expect(await findUser("stranger@example.com")).toBeNull();
    expect(await prisma.user.count()).toBe(1);
  });

  test("a pending invite admits the address: verified, named, no membership and no bootstrap marker", async () => {
    await createInvite("invitee@example.com");

    await sendCode("invitee@example.com");
    expect(sendSignInCodeEmail).toHaveBeenCalledOnce();
    const response = await signIn("invitee@example.com", lastMailedCode());

    expect(response.status).toBe(200);
    expect(hasSessionCookie(response)).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "invitee@example.com" },
      include: { memberships: true },
    });
    expect(user).toMatchObject({ emailVerified: true, name: "invitee", isBootstrapAdmin: null });
    expect(user.identityProvider).toBe("email");
    // Joining the organization is the invite page's job, not sign-in's.
    expect(user.memberships).toEqual([]);
  });

  test("an invite revoked between send and sign-in no longer admits the address", async () => {
    const invite = await createInvite("revoked@example.com");
    await sendCode("revoked@example.com");
    const otp = lastMailedCode();
    await prisma.invite.delete({ where: { id: invite.id } });

    await expectRefused(await signIn("revoked@example.com", otp));
    expect(await findUser("revoked@example.com")).toBeNull();
  });

  test("fresh instance: INITIAL_ADMIN_EMAIL (any case) becomes the bootstrap admin", async () => {
    await sendCode("Admin@Example.com");
    expect(sendSignInCodeEmail).toHaveBeenCalledOnce();
    const response = await signIn("Admin@Example.com", lastMailedCode());

    expect(response.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    expect(user.isBootstrapAdmin).toBe(BootstrapAdminMarker.bootstrapAdmin);
  });

  test("fresh instance: any other address gets no mail, and a valid code creates no account", async () => {
    await sendCode("first-comer@example.com");
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();

    const otp = await seedCode("first-comer@example.com");
    await expectRefused(await signIn("first-comer@example.com", otp));
    expect(await prisma.user.count()).toBe(0);
  });

  test.each([
    ["name", "Chosen Name"],
    ["image", "https://example.com/a.png"],
    ["isBootstrapAdmin", "bootstrapAdmin"],
    ["identityProvider", "google"],
  ])("a sign-in body carrying %s is refused before the code is checked", async (key, value) => {
    await createInvite("invitee@example.com");
    await sendCode("invitee@example.com");
    const otp = lastMailedCode();

    const response = await request(SIGN_IN_PATH, { email: "invitee@example.com", otp, [key]: value });
    expect(response.status).toBe(400);
    expect(await findUser("invitee@example.com")).toBeNull();

    // The refusal did not spend the code: the clean request still creates a plain account.
    expect((await signIn("invitee@example.com", otp)).status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "invitee@example.com" } });
    expect(user).toMatchObject({ name: "invitee", isBootstrapAdmin: null, identityProvider: "email" });
  });

  test("two concurrent sign-ins with the right code for a new address create exactly one account", async () => {
    await createInvite("racer@example.com");
    await sendCode("racer@example.com");
    const otp = lastMailedCode();

    const responses = await Promise.all([signIn("racer@example.com", otp), signIn("racer@example.com", otp)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(await prisma.user.count({ where: { email: "racer@example.com" } })).toBe(1);
  });
});

describe("email-code sign-in: account types a code never signs in", () => {
  test.each([
    ["two-factor", { twoFactorEnabled: true }],
    ["SSO", { identityProvider: "google" as const }],
    ["deactivated", { isActive: false }],
  ])("a %s account with the right code gets no session", async (_, data) => {
    await createUser("member@example.com", data);
    expect((await sendCode("member@example.com")).status).toBe(200);
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();

    const otp = await seedCode("member@example.com");
    const response = await signIn("member@example.com", otp);

    expect(hasSessionCookie(response)).toBe(false);
    expect(await prisma.session.count()).toBe(0);
    if (!("isActive" in data)) expect(await snapshot(response)).toEqual(INVALID_OTP);
  });
});
