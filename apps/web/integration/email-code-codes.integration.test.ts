import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@formbricks/database";
import {
  INVALID_OTP,
  clearSendQuota,
  closeRedis,
  createInvite,
  createUser,
  deviceCookie,
  flushRedis,
  getRedis,
  hasSessionCookie,
  lastMailedCode,
  mailedTo,
  sendCode,
  signIn,
  snapshot,
  wrongCode,
} from "@/integration/email-code-helpers";
import { resetDb } from "@/integration/reset-db";
import { RATE_LIMITING_DISABLED } from "@/lib/constants";
import { auth } from "@/modules/auth/lib/auth";
import { EMAIL_CODE_TTL_SECONDS } from "@/modules/auth/lib/email-code/constants";
import { sendSignInCodeEmail } from "@/modules/email";

/**
 * Email-code sign-in, the code itself: its shape and storage, single use, expiry, the per-code and
 * per-address guess limits, and that nothing in a response depends on the address.
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

const FLOOR_MS = 50;
vi.mock("@/modules/auth/lib/email-code/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/lib/email-code/constants")>()),
  EMAIL_CODE_SEND_FLOOR_MS: 50,
}));

const OWNER = "owner@example.com";

/** Sends a code to `email` (lifting the send caps first) and returns the code that was mailed. */
const freshCode = async (email = OWNER, cookie?: string): Promise<string> => {
  await clearSendQuota();
  vi.mocked(sendSignInCodeEmail).mockClear();
  expect((await sendCode(email, { cookie })).status).toBe(200);
  expect(sendSignInCodeEmail).toHaveBeenCalledOnce();
  return lastMailedCode();
};

/** What every send request answers, whatever the address, once the floor has passed. */
const SENT = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ success: true }),
  slow: true,
};

/** One send request: its status, type, body, and whether it took at least the floor. */
const timedSend = async (email: string, cookie?: string) => {
  const startedAt = Date.now();
  const response = await sendCode(email, { cookie });
  return { ...(await snapshot(response)), slow: Date.now() - startedAt >= FLOOR_MS - 3 };
};

/** `count` wrong guesses for `email`, each answered exactly like a wrong code. */
const guessWrong = async (email: string, otp: string, count: number) => {
  for (let i = 0; i < count; i++) {
    expect(await snapshot(await signIn(email, wrongCode(otp)))).toEqual(INVALID_OTP);
  }
};

beforeEach(async () => {
  await resetDb();
  await flushRedis();
  vi.clearAllMocks();
  await createUser(OWNER);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(closeRedis);

describe("email-code sign-in: the code", () => {
  test("is 8 digits and is never stored in the clear", async () => {
    const otp = await freshCode();
    expect(otp).toMatch(/^\d{8}$/);

    const redis = await getRedis();
    const keys = await redis.keys("*");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const value = (await redis.type(key)) === "string" ? ((await redis.get(key)) ?? "") : "";
      expect(`${key} ${value}`).not.toContain(otp);
      expect(key).not.toContain(OWNER);
    }
  });

  test("is refused once expired, exactly like a wrong code", async () => {
    const otp = await freshCode();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + (EMAIL_CODE_TTL_SECONDS + 1) * 1000);

    const response = await signIn(OWNER, otp);
    expect(await snapshot(response)).toEqual(INVALID_OTP);
    expect(await prisma.session.count()).toBe(0);
  });

  test("works once: a replay is refused", async () => {
    const otp = await freshCode();
    const first = await signIn(OWNER, otp);
    expect(first.status).toBe(200);
    expect(hasSessionCookie(first)).toBe(true);

    expect(await snapshot(await signIn(OWNER, otp))).toEqual(INVALID_OTP);
    expect(await prisma.session.count()).toBe(1);
  });

  test("five parallel submissions of the right code yield exactly one session", async () => {
    const otp = await freshCode();
    const responses = await Promise.all(Array.from({ length: 5 }, () => signIn(OWNER, otp)));

    expect(responses.filter(hasSessionCookie)).toHaveLength(1);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400, 400, 400, 400]);
    expect(await prisma.session.count()).toBe(1);
  });
});

describe("email-code sign-in: guessing", () => {
  test("the 6th attempt on one code is refused even with the right code", async () => {
    const otp = await freshCode();
    await guessWrong(OWNER, otp, 5);

    const response = await signIn(OWNER, otp);
    expect(await snapshot(response)).toEqual(INVALID_OTP);
    expect(await prisma.session.count()).toBe(0);
  });

  test("a resend rotates the code: the old one stops working, the new one works", async () => {
    const first = await freshCode();
    const second = await freshCode();
    expect(second).not.toBe(first);

    expect(await snapshot(await signIn(OWNER, first))).toEqual(INVALID_OTP);
    expect((await signIn(OWNER, second)).status).toBe(200);
  });

  test("10 attempts per address per day, across resends and with RATE_LIMITING_DISABLED", async () => {
    expect(RATE_LIMITING_DISABLED).toBe(true);
    // Never more than four wrong guesses on one code, so the per-code limit is not what stops the 11th.
    for (const count of [4, 4, 2]) await guessWrong(OWNER, await freshCode(), count);

    const otp = await freshCode();
    const response = await signIn(OWNER, otp);
    expect(await snapshot(response)).toEqual(INVALID_OTP);
    expect(await prisma.session.count()).toBe(0);
  });

  test("a trusted device keeps its own budget after a stranger spends the shared one", async () => {
    const owner = await signIn(OWNER, await freshCode());
    expect(owner.status).toBe(200);
    const device = deviceCookie(owner);
    await prisma.session.deleteMany();

    // A stranger spends the address's shared budget.
    await guessWrong(OWNER, "12345678", 10);

    // The shared pool refuses even a right code now...
    const otp = await freshCode(OWNER, device);
    expect(await snapshot(await signIn(OWNER, otp))).toEqual(INVALID_OTP);
    // ...but the owner's known browser still gets in with it.
    const again = await signIn(OWNER, otp, { cookie: device });
    expect(again.status).toBe(200);
    expect(hasSessionCookie(again)).toBe(true);
  });

  test("over the send cap: same response after the floor, no mail, and the mailed code still works", async () => {
    expect(await timedSend(OWNER)).toEqual(SENT);
    const otp = lastMailedCode();

    // Anyone asking again for this address is answered identically, but neither mails nor replaces the
    // code: otherwise a stranger could kill the owner's emailed code at will.
    for (let i = 0; i < 3; i++) expect(await timedSend(OWNER)).toEqual(SENT);
    expect(sendSignInCodeEmail).toHaveBeenCalledOnce();

    const response = await signIn(OWNER, otp);
    expect(response.status).toBe(200);
    expect(hasSessionCookie(response)).toBe(true);
  });

  test("a send for an address that is not admitted stores no code at all", async () => {
    expect(await timedSend("unknown@example.com")).toEqual(SENT);

    const context = await auth.$context;
    expect(await context.internalAdapter.findVerificationValue("sign-in-otp-unknown@example.com")).toBeNull();
    expect(await (await getRedis()).keys("verification:*")).toEqual([]);
  });

  test("a trusted device still gets a working code after strangers spend the shared send and guess budgets", async () => {
    const owner = await signIn(OWNER, await freshCode());
    const device = deviceCookie(owner);
    await prisma.session.deleteMany();

    // Strangers use up the address's shared send cap and its shared daily guesses.
    for (let i = 0; i < 3; i++) expect(await timedSend(OWNER)).toEqual(SENT);
    await guessWrong(OWNER, "12345678", 10);
    vi.mocked(sendSignInCodeEmail).mockClear();

    // The owner's known browser asks for a code, without any window having passed.
    expect(await timedSend(OWNER, device)).toEqual(SENT);
    expect(sendSignInCodeEmail).toHaveBeenCalledOnce();
    const response = await signIn(OWNER, lastMailedCode(), { cookie: device });
    expect(response.status).toBe(200);
    expect(hasSessionCookie(response)).toBe(true);
  });
});

describe("email-code sign-in: nothing depends on the address", () => {
  test("send answers every kind of address the same way, after the floor, and mails only eligible ones", async () => {
    await createUser("inactive@example.com", { isActive: false });
    await createUser("sso@example.com", { identityProvider: "google" });
    await createUser("tfa@example.com", { twoFactorEnabled: true });
    await createInvite("invited@example.com");
    const addresses = [
      OWNER,
      "unknown@example.com",
      "inactive@example.com",
      "sso@example.com",
      "tfa@example.com",
      "invited@example.com",
      OWNER, // again within the minute: throttled
    ];

    const results = [];
    for (const address of addresses) results.push(await timedSend(address));

    expect(results).toEqual(addresses.map(() => SENT));
    expect(mailedTo().sort()).toEqual(["invited@example.com", OWNER]);
  });

  test("a wrong code reads the same for a known and an unknown address", async () => {
    const otp = await freshCode();
    const known = await snapshot(await signIn(OWNER, wrongCode(otp)));
    const unknown = await snapshot(await signIn("unknown@example.com", "12345678"));

    expect(known).toEqual(unknown);
    expect(known).toEqual(INVALID_OTP);
  });
});
