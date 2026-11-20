import { APIError } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@formbricks/database";
import { AuthenticationError, InvalidInputError, OperationNotAllowedError } from "@formbricks/types/errors";
import {
  ACCOUNT_DELETION_INVALID_CODE_MESSAGE,
  ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE,
} from "@/modules/account/constants";
import { mailAccountCode } from "@/modules/auth/lib/email-code/account-code";
import { getSession } from "@/modules/auth/lib/session";
import {
  deleteAccountWithCode,
  requestAccountDeletionCode,
  requestSsoAccountDeletionEmail,
} from "./better-auth-account-deletion-request";

const mocks = vi.hoisted(() => ({
  flags: { emailCode: true },
  createVerificationValue: vi.fn(),
  deleteUser: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  get EMAIL_CODE_AUTH_ENABLED() {
    return mocks.flags.emailCode;
  },
}));
vi.mock("@formbricks/database", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/modules/auth/lib/session", () => ({ getSession: vi.fn() }));
vi.mock("@/modules/auth/lib/email-code/account-code", () => ({ mailAccountCode: vi.fn() }));
vi.mock("@/modules/email", () => ({ sendDeleteAccountConfirmationEmail: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ cookie: "session=abc" })),
  cookies: vi.fn(async () => ({ set: mocks.cookieSet })),
}));
vi.mock("@/modules/auth/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: { createVerificationValue: mocks.createVerificationValue },
      authCookies: {
        sessionToken: { name: "__Host-x.session_token", attributes: { secure: true, path: "/" } },
        sessionData: { name: "__Host-x.session_data", attributes: { secure: true, path: "/" } },
        dontRememberToken: { name: "__Host-x.dont_remember", attributes: { secure: true, path: "/" } },
      },
    }),
    api: { deleteUser: mocks.deleteUser },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags.emailCode = true;
  vi.mocked(getSession).mockResolvedValue({
    user: { id: "user-1", email: "session@example.com" },
  } as Awaited<ReturnType<typeof getSession>>);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: "row@example.com", locale: "de-DE" } as never);
  vi.mocked(mailAccountCode).mockResolvedValue(true);
  mocks.deleteUser.mockResolvedValue({ success: true });
});
afterEach(() => {
  mocks.flags.emailCode = true;
});

describe("requestAccountDeletionCode", () => {
  test("mints Better Auth's delete token as an 8-digit code bound to the user, valid 10 minutes, and mails it", async () => {
    const before = Date.now();
    await requestAccountDeletionCode();

    expect(mocks.createVerificationValue).toHaveBeenCalledOnce();
    const { identifier, value, expiresAt } = mocks.createVerificationValue.mock.calls[0][0];
    expect(identifier).toMatch(/^delete-account-\d{8}$/);
    expect(value).toBe("user-1");
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(600_000 - 50);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);

    const code = identifier.slice("delete-account-".length);
    // The address and locale come from the database row, not the session or the request.
    expect(mailAccountCode).toHaveBeenCalledExactlyOnceWith({
      to: "row@example.com",
      code,
      purpose: "delete_account",
      locale: "de-DE",
      userId: "user-1",
    });
  });

  test("each request mints a fresh code", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) await requestAccountDeletionCode();
    for (const [{ identifier }] of mocks.createVerificationValue.mock.calls) codes.add(identifier);
    expect(codes.size).toBeGreaterThan(1);
  });

  test("throws when the mail was not accepted, so the user is not told a code is on its way", async () => {
    vi.mocked(mailAccountCode).mockResolvedValue(false);
    await expect(requestAccountDeletionCode()).rejects.toThrow();
  });

  test("refuses without a session, minting nothing", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    await expect(requestAccountDeletionCode()).rejects.toThrow(AuthenticationError);
    expect(mocks.createVerificationValue).not.toHaveBeenCalled();
  });

  test("refuses when email-code sign-in is off, minting nothing", async () => {
    mocks.flags.emailCode = false;
    await expect(requestAccountDeletionCode()).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.createVerificationValue).not.toHaveBeenCalled();
    expect(mailAccountCode).not.toHaveBeenCalled();
  });
});

describe("requestSsoAccountDeletionEmail with email codes on", () => {
  test("is refused: every account confirms by code", async () => {
    await expect(requestSsoAccountDeletionEmail()).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.createVerificationValue).not.toHaveBeenCalled();
  });
});

describe("deleteAccountWithCode", () => {
  test("deletes through Better Auth's own deleteUser with the code as its token, in-process", async () => {
    await deleteAccountWithCode("48207135");

    expect(mocks.deleteUser).toHaveBeenCalledOnce();
    const [{ body, headers, ...rest }] = mocks.deleteUser.mock.calls[0];
    expect(body).toEqual({ token: "48207135" });
    expect(headers.get("cookie")).toBe("session=abc");
    // No request: Better Auth treats it as an in-process call, which the HTTP-only 404 guard lets through.
    expect(rest).not.toHaveProperty("request");
  });

  test("expires the auth cookies after the deletion, with their own attributes", async () => {
    await deleteAccountWithCode("48207135");

    expect(mocks.cookieSet).toHaveBeenCalledTimes(3);
    for (const [, value, options] of mocks.cookieSet.mock.calls) {
      expect(value).toBe("");
      expect(options).toMatchObject({ maxAge: 0, secure: true, path: "/" });
    }
  });

  test.each([
    [
      "wrong, used, expired or someone else's",
      APIError.from("NOT_FOUND", { message: "Invalid token", code: "INVALID_TOKEN" }),
    ],
  ])("answers one message for a %s code", async (_name, error) => {
    mocks.deleteUser.mockRejectedValue(error);
    const failure = deleteAccountWithCode("48207135");
    await expect(failure).rejects.toThrow(InvalidInputError);
    await expect(failure).rejects.toThrow(ACCOUNT_DELETION_INVALID_CODE_MESSAGE);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  test("passes the sole-owner refusal through with its exact message", async () => {
    mocks.deleteUser.mockRejectedValue(
      new APIError("BAD_REQUEST", { message: ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE })
    );
    const failure = deleteAccountWithCode("48207135");
    await expect(failure).rejects.toThrow(OperationNotAllowedError);
    await expect(failure).rejects.toThrow(ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE);
  });

  test("maps a missing session to AuthenticationError", async () => {
    mocks.deleteUser.mockRejectedValue(
      APIError.from("UNAUTHORIZED", { message: "Unauthorized", code: "UNAUTHORIZED" })
    );
    await expect(deleteAccountWithCode("48207135")).rejects.toThrow(AuthenticationError);
  });

  test("rethrows anything else unchanged", async () => {
    const failure = new Error("redis down");
    mocks.deleteUser.mockRejectedValue(failure);
    await expect(deleteAccountWithCode("48207135")).rejects.toBe(failure);
  });

  test("refuses when email-code sign-in is off, without calling Better Auth", async () => {
    mocks.flags.emailCode = false;
    await expect(deleteAccountWithCode("48207135")).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
});
