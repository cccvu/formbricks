import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@formbricks/database";
import { BootstrapAdminMarker } from "@formbricks/database/prisma";
import {
  closeRedis,
  flushRedis,
  hasSessionCookie,
  lastMailedCode,
  request,
  sendCode,
  signIn,
} from "@/integration/email-code-helpers";
import { resetDb } from "@/integration/reset-db";
import { EMAIL_AUTH_ENABLED, EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";
import { auth } from "@/modules/auth/lib/auth";

/**
 * Email-code sign-in, what is reachable: only send and sign-in are served, every other email-OTP and
 * password route is closed however its URL is spelled. INITIAL_ADMIN_EMAIL is unset here, which also
 * keeps the previous fresh-instance behavior (the first account becomes the admin, whatever its address).
 */
vi.hoisted(() => {
  process.env.EMAIL_CODE_AUTH_ENABLED = "1";
  process.env.EMAIL_AUTH_DISABLED = "1";
  process.env.PASSWORD_RESET_DISABLED = "1";
  process.env.SES_REGION = "us-east-1";
  process.env.MAIL_FROM = "noreply@example.com";
  process.env.IS_FORMBRICKS_CLOUD = "0";
  process.env.E2E_TESTING = "0";
  delete process.env.INITIAL_ADMIN_EMAIL;
});

vi.mock("@/modules/auth/lib/email-code/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/lib/email-code/constants")>()),
  EMAIL_CODE_SEND_FLOOR_MS: 50,
}));

const OTHER_EMAIL_OTP_ENDPOINTS = [
  "createVerificationOTP",
  "getVerificationOTP",
  "checkVerificationOTP",
  "verifyEmailOTP",
  "requestPasswordResetEmailOTP",
  "forgetPasswordEmailOTP",
  "resetPasswordEmailOTP",
  "requestEmailChangeEmailOTP",
  "changeEmailEmailOTP",
];

const CLOSED_PATHS = [
  "/email-otp/verify-email",
  "/email-otp/reset-password",
  "/email-otp/check-verification-otp",
  "/email-otp/request-password-reset",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/forget-password/email-otp",
];

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
});

afterAll(closeRedis);

describe("email-code sign-in: endpoint surface", () => {
  test("the flags this file depends on took effect", () => {
    expect(EMAIL_CODE_AUTH_ENABLED).toBe(true);
    expect(EMAIL_AUTH_ENABLED).toBe(false);
  });

  test("auth.api exposes send and sign-in, and none of the other emailOTP endpoints", () => {
    const api = Object.keys(auth.api);
    expect(api).toEqual(expect.arrayContaining(["sendVerificationOTP", "signInEmailOTP"]));
    expect(api.filter((name) => OTHER_EMAIL_OTP_ENDPOINTS.includes(name))).toEqual([]);
  });

  test.each(CLOSED_PATHS)("%s answers 404 however it is spelled", async (path) => {
    for (const spelling of spellings(path)) {
      const response = await request(spelling, { email: "person@example.com", otp: "12345678" });
      expect(response.status, spelling).toBe(404);
    }
  });

  test("password sign-in answers 4xx and sets no session", async () => {
    await prisma.user.create({ data: { email: "pw@example.com", name: "pw", emailVerified: true } });
    const response = await request("/sign-in/email", { email: "pw@example.com", password: "Passw0rd!123" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(hasSessionCookie(response)).toBe(false);
  });

  test.each(["/change-password", "/verify-password"])("%s answers 404", async (path) => {
    expect((await request(path, { currentPassword: "x", newPassword: "y", password: "x" })).status).toBe(404);
  });

  test("password reset is refused (403 from the PASSWORD_RESET_DISABLED gate, which runs first)", async () => {
    expect((await request("/reset-password", { newPassword: "Passw0rd!123", token: "t" })).status).toBe(403);
    expect((await request("/reset-password/some-token", undefined, { method: "GET" })).status).toBe(404);
  });
});

describe("email-code sign-in: INITIAL_ADMIN_EMAIL unset keeps the previous fresh-instance behavior", () => {
  test("the first account on a fresh instance is created as the bootstrap admin", async () => {
    await sendCode("first@example.com");
    const response = await signIn("first@example.com", lastMailedCode());

    expect(response.status).toBe(200);
    expect(hasSessionCookie(response)).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "first@example.com" } });
    expect(user.isBootstrapAdmin).toBe(BootstrapAdminMarker.bootstrapAdmin);
  });
});
