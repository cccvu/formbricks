import { symmetricEncrypt } from "better-auth/crypto";
import { createClient } from "redis";
import { vi } from "vitest";
import { prisma } from "@formbricks/database";
import { auth } from "@/modules/auth/lib/auth";
import { SESSION_TOKEN_COOKIE_NAME } from "@/modules/auth/lib/auth-cookies";
import { getEmailCodeDeviceCookieName } from "@/modules/auth/lib/email-code/device";
import { EMAIL_CODE_REDIS_PREFIX } from "@/modules/auth/lib/email-code/limits";
import { sendSignInCodeEmail } from "@/modules/email";

/**
 * Shared helpers for the email-code sign-in integration tests. Requests go through `auth.handler`, so
 * the router, the root hooks, the plugin's guards and the database hooks all run as they do in prod.
 *
 * Import this AFTER the test file has set its env (vi.hoisted): it imports the auth instance.
 */

/** The trusted origin: BETTER_AUTH_URL from the loaded .env. */
export const ORIGIN = "http://localhost:3000";
export const SEND_PATH = "/email-otp/send-verification-otp";
export const SIGN_IN_PATH = "/sign-in/email-otp";

type TRequestOptions = { origin?: string | null; cookie?: string; method?: string };

/** A raw request to `/api/auth<path>`. `rawPath` is used verbatim, so URL spelling variants survive. */
export const request = (
  rawPath: string,
  body?: unknown,
  options: TRequestOptions = {}
): Promise<Response> => {
  const { origin = ORIGIN, cookie, method = "POST" } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  return auth.handler(
    new Request(`${ORIGIN}/api/auth${rawPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
};

export const sendCode = (email: string, options?: TRequestOptions) =>
  request(SEND_PATH, { email, type: "sign-in" }, options);

export const signIn = (email: string, otp: string, options?: TRequestOptions) =>
  request(SIGN_IN_PATH, { email, otp }, options);

/** Status, type and raw body: two refusals are indistinguishable only if all match byte for byte. */
export const snapshot = async (response: Response) => ({
  status: response.status,
  contentType: response.headers.get("content-type"),
  body: await response.text(),
});

/** What Better Auth answers for a wrong code; every address-dependent refusal must match it. */
export const INVALID_OTP = {
  status: 400,
  contentType: "application/json",
  body: JSON.stringify({ message: "Invalid OTP", code: "INVALID_OTP" }),
};

export const mailedCodes = (): string[] => vi.mocked(sendSignInCodeEmail).mock.calls.map((call) => call[1]);
export const mailedTo = (): string[] => vi.mocked(sendSignInCodeEmail).mock.calls.map((call) => call[0]);
export const lastMailedCode = (): string => vi.mocked(sendSignInCodeEmail).mock.calls.at(-1)![1];

export const cookieHeader = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

export const hasSessionCookie = (response: Response): boolean =>
  response.headers
    .getSetCookie()
    .some(
      (cookie) =>
        cookie.startsWith(`${SESSION_TOKEN_COOKIE_NAME}=`) &&
        !cookie.startsWith(`${SESSION_TOKEN_COOKIE_NAME}=;`)
    );

/** Just the trusted-device cookie from a response, ready for a `cookie` header. */
export const deviceCookie = (response: Response): string => {
  const name = getEmailCodeDeviceCookieName();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error("expected a trusted-device cookie on the response");
  return cookie;
};

/**
 * Stores a sign-in code for `email` the way the plugin does (encrypted with the auth secret, zero
 * attempts used), without mailing it: for addresses the send path never mails.
 */
export const seedCode = async (email: string, otp = "13572468"): Promise<string> => {
  const context = await auth.$context;
  const stored = await symmetricEncrypt({ key: context.secretConfig, data: otp });
  await context.internalAdapter.createVerificationValue({
    value: `${stored}:0`,
    identifier: `sign-in-otp-${email.toLowerCase()}`,
    expiresAt: new Date(Date.now() + 600_000),
  });
  return otp;
};

/** A different 8-digit code than `otp`. */
export const wrongCode = (otp: string): string => (otp === "00000000" ? "11111111" : "00000000");

let redis: ReturnType<typeof createClient> | undefined;
export const getRedis = async () => {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
  }
  return redis;
};
export const closeRedis = async () => {
  await redis?.quit();
  redis = undefined;
};

/** Clears verification records, per-address counters and sessions from the test Redis database. */
export const flushRedis = async () => {
  await (await getRedis()).flushDb();
};

/** Lets the next send through the per-address send caps, as if the windows had passed. */
export const clearSendQuota = async () => {
  const client = await getRedis();
  const keys = await client.keys(`${EMAIL_CODE_REDIS_PREFIX}send:*`);
  if (keys.length) await client.del(keys);
};

export const createUser = (
  email: string,
  data: { isActive?: boolean; twoFactorEnabled?: boolean; identityProvider?: "email" | "google" } = {}
) =>
  prisma.user.create({
    data: { email, name: email.split("@")[0], emailVerified: true, ...data },
  });

/** An organization with a pending invite for `email` (the instance is then no longer fresh). */
export const createInvite = async (email: string, expiresAt = new Date(Date.now() + 86_400_000)) => {
  const creator = await createUser(`inviter-${Date.now()}@example.com`);
  const organization = await prisma.organization.create({ data: { name: "Invite Org" } });
  return prisma.invite.create({
    data: {
      email,
      organizationId: organization.id,
      creatorId: creator.id,
      expiresAt,
    },
  });
};
