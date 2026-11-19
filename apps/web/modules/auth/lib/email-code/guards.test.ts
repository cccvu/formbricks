import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ZUserName } from "@formbricks/types/user";
import type { AuthHookContext } from "@/modules/ee/sso/lib/better-auth-hooks";
import { EMAIL_CODE_SEND_PATH, EMAIL_CODE_SIGN_IN_PATH } from "./constants";
import { deriveNameFromEmail, emailCodeAfterHandler, emailCodeBeforeHandler } from "./guards";
import { consumeEmailCodeVerifyQuota } from "./limits";
import { createEmailOTPBase } from "./plugin";
import { markEmailCodeSendStart, padEmailCodeSendToFloor, shouldSendEmailCode } from "./send";

vi.mock("@/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/constants")>()),
  EMAIL_AUTH_ENABLED: false,
}));
vi.mock("./limits", () => ({ consumeEmailCodeVerifyQuota: vi.fn() }));
vi.mock("./send", () => ({
  shouldSendEmailCode: vi.fn(),
  markEmailCodeSendStart: vi.fn(),
  padEmailCodeSendToFloor: vi.fn(),
  sendEmailCodeGated: vi.fn(),
}));
vi.mock("@formbricks/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TRUSTED = "https://app.example.test";

const hookCtx = ({
  path,
  body,
  origin = TRUSTED,
  returned,
  newSession,
  request,
}: {
  path: string;
  body?: unknown;
  origin?: string | null;
  returned?: unknown;
  newSession?: unknown;
  request?: Request;
}) =>
  ({
    path,
    body,
    request,
    headers: new Headers(origin ? { origin } : {}),
    getCookie: () => null,
    setCookie: vi.fn(),
    json: (value: unknown) => value,
    context: { isTrustedOrigin: (url: string) => url === TRUSTED, returned, newSession },
  }) as unknown as AuthHookContext;

const sendBody = { email: "person@example.com", type: "sign-in" };
const signInBody = { email: "person@example.com", otp: "48207135" };

/** Better Auth's own wrong-code error, exactly as `atomicVerifyOTP` builds it. */
const upstreamInvalidOtp = () => APIError.from("BAD_REQUEST", createEmailOTPBase().$ERROR_CODES.INVALID_OTP);
const shape = (error: unknown) => {
  const { status, statusCode, body } = error as APIError;
  return { status, statusCode, body: JSON.stringify(body) };
};

beforeEach(() => {
  vi.mocked(consumeEmailCodeVerifyQuota).mockResolvedValue(true);
  vi.mocked(shouldSendEmailCode).mockResolvedValue(true);
  vi.mocked(padEmailCodeSendToFloor).mockResolvedValue(undefined);
});

describe("emailCodeBeforeHandler", () => {
  test.each([EMAIL_CODE_SEND_PATH, EMAIL_CODE_SIGN_IN_PATH])(
    "%s refuses a missing or untrusted origin",
    async (path) => {
      const body = path === EMAIL_CODE_SEND_PATH ? sendBody : signInBody;
      for (const origin of [null, "https://evil.example.test", "null"]) {
        await expect(emailCodeBeforeHandler(hookCtx({ path, body, origin }))).rejects.toMatchObject({
          status: "FORBIDDEN",
        });
      }
      await expect(emailCodeBeforeHandler(hookCtx({ path, body }))).resolves.toBeUndefined();
    }
  );

  test.each(["name", "image", "isBootstrapAdmin", "identityProvider", "callbackURL"])(
    "refuses an extra %s key on both endpoints",
    async (key) => {
      await expect(
        emailCodeBeforeHandler(
          hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: { ...signInBody, [key]: "x" } })
        )
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
      await expect(
        emailCodeBeforeHandler(hookCtx({ path: EMAIL_CODE_SEND_PATH, body: { ...sendBody, [key]: "x" } }))
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
      expect(consumeEmailCodeVerifyQuota).not.toHaveBeenCalled();
    }
  );

  test.each(["forget-password", "email-verification", "change-email", undefined])(
    "refuses a send of type %s",
    async (type) => {
      await expect(
        emailCodeBeforeHandler(hookCtx({ path: EMAIL_CODE_SEND_PATH, body: { ...sendBody, type } }))
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
    }
  );

  test("lets an admitted send within its caps through to Better Auth, timed from the request start", async () => {
    const request = new Request("https://app.example.test/api/auth/email-otp/send-verification-otp");
    const ctx = hookCtx({ path: EMAIL_CODE_SEND_PATH, body: sendBody, request });
    await expect(emailCodeBeforeHandler(ctx)).resolves.toBeUndefined();
    expect(shouldSendEmailCode).toHaveBeenCalledExactlyOnceWith(sendBody.email, ctx);
    expect(markEmailCodeSendStart).toHaveBeenCalledWith(request, expect.any(Number));
    expect(padEmailCodeSendToFloor).not.toHaveBeenCalled();
  });

  // Better Auth lowercases the address and then rejects anything `z.email()` refuses. Deciding admission on
  // any looser form would make that INVALID_EMAIL appear only for admitted addresses (an account oracle).
  test.each([" person@example.com", "person@example.com ", "%@example.com", "per son@example.com", ""])(
    "hands the malformed address %j straight to Better Auth without looking it up",
    async (email) => {
      const ctx = hookCtx({ path: EMAIL_CODE_SEND_PATH, body: { ...sendBody, email } });
      await expect(emailCodeBeforeHandler(ctx)).resolves.toBeUndefined();
      expect(shouldSendEmailCode).not.toHaveBeenCalled();
      expect(markEmailCodeSendStart).not.toHaveBeenCalled();
    }
  );

  test("decides admission on the address exactly as Better Auth stores it (lowercased)", async () => {
    const ctx = hookCtx({ path: EMAIL_CODE_SEND_PATH, body: { ...sendBody, email: "Person@Example.COM" } });
    await emailCodeBeforeHandler(ctx);
    expect(shouldSendEmailCode).toHaveBeenCalledExactlyOnceWith("person@example.com", ctx);
  });

  test("answers a refused send itself, after the floor, so Better Auth never stores a new code", async () => {
    vi.mocked(shouldSendEmailCode).mockResolvedValueOnce(false);
    const result = await emailCodeBeforeHandler(hookCtx({ path: EMAIL_CODE_SEND_PATH, body: sendBody }));
    expect(result).toEqual({ success: true });
    expect(padEmailCodeSendToFloor).toHaveBeenCalledOnce();
  });

  test("checks origin, body and type before deciding anything about the address", async () => {
    await emailCodeBeforeHandler(hookCtx({ path: EMAIL_CODE_SEND_PATH, body: sendBody, origin: null })).catch(
      () => undefined
    );
    await emailCodeBeforeHandler(
      hookCtx({ path: EMAIL_CODE_SEND_PATH, body: { ...sendBody, type: "forget-password" } })
    ).catch(() => undefined);
    expect(shouldSendEmailCode).not.toHaveBeenCalled();
  });

  test("answers a spent or unavailable per-address quota exactly like a wrong code", async () => {
    vi.mocked(consumeEmailCodeVerifyQuota).mockResolvedValueOnce(false);
    const throttled = await emailCodeBeforeHandler(
      hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody })
    ).catch((error: unknown) => error);
    expect(shape(throttled)).toEqual(shape(upstreamInvalidOtp()));

    vi.mocked(consumeEmailCodeVerifyQuota).mockRejectedValueOnce(new Error("redis down"));
    const failedClosed = await emailCodeBeforeHandler(
      hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody })
    ).catch((error: unknown) => error);
    expect(shape(failedClosed)).toEqual(shape(upstreamInvalidOtp()));
  });

  test.each(["/email-otp/verify-email", "/email-otp/reset-password", "/email-otp/some-future-endpoint"])(
    "answers 404 for %s",
    async (path) => {
      await expect(emailCodeBeforeHandler(hookCtx({ path, body: sendBody }))).rejects.toMatchObject({
        status: "NOT_FOUND",
      });
    }
  );

  test.each(["/change-password", "/verify-password", "/reset-password", "/reset-password/:token"])(
    "answers 404 for %s while password sign-in is off",
    async (path) => {
      await expect(emailCodeBeforeHandler(hookCtx({ path }))).rejects.toMatchObject({ status: "NOT_FOUND" });
    }
  );
});

describe("emailCodeAfterHandler", () => {
  test.each(["TOO_MANY_ATTEMPTS", "OTP_EXPIRED"] as const)(
    "turns %s into a response byte-identical to a wrong code",
    async (code) => {
      const upstream = APIError.from(
        code === "TOO_MANY_ATTEMPTS" ? "FORBIDDEN" : "BAD_REQUEST",
        createEmailOTPBase().$ERROR_CODES[code]
      );
      const thrown = await emailCodeAfterHandler(
        hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody, returned: upstream })
      ).catch((error: unknown) => error);
      expect(shape(thrown)).toEqual(shape(upstreamInvalidOtp()));
    }
  );

  test.each(["TOO_MANY_ATTEMPTS", "OTP_EXPIRED"] as const)(
    "over HTTP answers %s with the full wrong-code response, status included",
    async (code) => {
      const upstream = APIError.from(
        code === "TOO_MANY_ATTEMPTS" ? "FORBIDDEN" : "BAD_REQUEST",
        createEmailOTPBase().$ERROR_CODES[code]
      );
      const request = new Request("https://app.example.test/api/auth/sign-in/email-otp", { method: "POST" });
      const response = await emailCodeAfterHandler(
        hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody, returned: upstream, request })
      );
      const expected = upstreamInvalidOtp();
      expect(response).toBeInstanceOf(Response);
      expect(response!.status).toBe(expected.statusCode);
      expect(response!.headers.get("content-type")).toBe("application/json");
      expect(await response!.text()).toBe(JSON.stringify(expected.body));
    }
  );

  test("leaves a wrong-code error as it is", async () => {
    await expect(
      emailCodeAfterHandler(
        hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody, returned: upstreamInvalidOtp() })
      )
    ).resolves.toBeUndefined();
  });

  test.each([
    ["a wrong code", () => upstreamInvalidOtp()],
    ["a burned code", () => APIError.from("FORBIDDEN", createEmailOTPBase().$ERROR_CODES.TOO_MANY_ATTEMPTS)],
  ])("never marks the browser as a trusted device after %s", async (_label, makeError) => {
    const request = new Request("https://app.example.test/api/auth/sign-in/email-otp", { method: "POST" });
    const ctx = hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody, returned: makeError(), request });
    await emailCodeAfterHandler(ctx);
    expect(ctx.setCookie).not.toHaveBeenCalled();
  });

  test("never marks the browser as a trusted device when no session was created", async () => {
    const ctx = hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody, returned: { token: null } });
    await emailCodeAfterHandler(ctx);
    expect(ctx.setCookie).not.toHaveBeenCalled();
  });

  test("marks the browser as a trusted device for the address after a successful sign-in", async () => {
    const ctx = hookCtx({ path: EMAIL_CODE_SIGN_IN_PATH, body: signInBody, newSession: { session: {} } });
    await emailCodeAfterHandler(ctx);
    expect(ctx.setCookie).toHaveBeenCalledWith(
      expect.stringContaining("email_code_device"),
      expect.any(String),
      expect.objectContaining({ httpOnly: true, path: "/" })
    );
  });
});

describe("deriveNameFromEmail", () => {
  test.each([
    ["first.last@example.com", "first last"],
    ["first_last@example.com", "first last"],
    ["a+tag@example.com", "a tag"],
    ["Jane@Example.com", "jane"],
    ["!!!@example.com", "User"],
  ])("derives a valid display name from %s", (email, expected) => {
    const name = deriveNameFromEmail(email);
    expect(name).toBe(expected);
    expect(ZUserName.safeParse(name).success).toBe(true);
  });
});
