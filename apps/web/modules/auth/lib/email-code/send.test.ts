import { beforeEach, describe, expect, test, vi } from "vitest";
import { logger } from "@formbricks/logger";
import { sendSignInCodeEmail } from "@/modules/email";
import { isEmailCodeRecipientAdmitted } from "./admission";
import { consumeEmailCodeSendQuota } from "./limits";
import { markEmailCodeSendStart, sendEmailCodeGated, shouldSendEmailCode } from "./send";

const FLOOR_MS = 50;

vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants")>()),
  EMAIL_CODE_SEND_FLOOR_MS: 50,
}));
vi.mock("./admission", () => ({ isEmailCodeRecipientAdmitted: vi.fn() }));
vi.mock("./limits", () => ({ consumeEmailCodeSendQuota: vi.fn() }));
vi.mock("@/modules/email", () => ({ sendSignInCodeEmail: vi.fn() }));
vi.mock("@formbricks/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const email = "person@example.com";
const otp = "48207135";

/** Runs one mail callback and returns how long it took. */
const timedSend = async (type = "sign-in", ctx?: { request?: Request }): Promise<number> => {
  const startedAt = Date.now();
  await expect(sendEmailCodeGated({ email, otp, type }, ctx)).resolves.toBeUndefined();
  return Date.now() - startedAt;
};

// Timers can fire a millisecond or two early against Date.now(); the floor is about hiding a
// difference of hundreds of milliseconds, not about exactness.
const SLACK_MS = 3;

const loggedText = () =>
  JSON.stringify(
    [logger.debug, logger.info, logger.warn, logger.error].flatMap((fn) => vi.mocked(fn).mock.calls)
  );

beforeEach(() => {
  vi.mocked(isEmailCodeRecipientAdmitted).mockResolvedValue(true);
  vi.mocked(consumeEmailCodeSendQuota).mockResolvedValue(true);
  vi.mocked(sendSignInCodeEmail).mockResolvedValue(true);
});

describe("shouldSendEmailCode (the before-hook's decision)", () => {
  test("allows an admitted address within its caps, spending one send", async () => {
    await expect(shouldSendEmailCode(email, undefined)).resolves.toBe(true);
    expect(consumeEmailCodeSendQuota).toHaveBeenCalledExactlyOnceWith(expect.any(String), "shared");
  });

  test("refuses an address that is not admitted, without spending its send quota", async () => {
    vi.mocked(isEmailCodeRecipientAdmitted).mockResolvedValue(false);
    await expect(shouldSendEmailCode(email, undefined)).resolves.toBe(false);
    expect(consumeEmailCodeSendQuota).not.toHaveBeenCalled();
  });

  test("refuses an address over its send caps", async () => {
    vi.mocked(consumeEmailCodeSendQuota).mockResolvedValue(false);
    await expect(shouldSendEmailCode(email, undefined)).resolves.toBe(false);
  });

  test.each([
    ["admission lookup", () => vi.mocked(isEmailCodeRecipientAdmitted).mockRejectedValue(new Error(email))],
    ["quota store", () => vi.mocked(consumeEmailCodeSendQuota).mockRejectedValue(new Error(email))],
  ])("fails closed without throwing when the %s fails", async (_, arrange) => {
    arrange();
    await expect(shouldSendEmailCode(email, undefined)).resolves.toBe(false);
    expect(loggedText()).not.toContain(email);
  });
});

describe("sendEmailCodeGated (the mail callback)", () => {
  test("mails the code, after the floor", async () => {
    expect(await timedSend()).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
    expect(sendSignInCodeEmail).toHaveBeenCalledExactlyOnceWith(email, otp);
    // The quota was the hook's to spend; the callback must not spend it a second time.
    expect(consumeEmailCodeSendQuota).not.toHaveBeenCalled();
  });

  test.each([
    [
      "the address is no longer admitted",
      () => vi.mocked(isEmailCodeRecipientAdmitted).mockResolvedValue(false),
    ],
    [
      "the admission lookup fails",
      () => vi.mocked(isEmailCodeRecipientAdmitted).mockRejectedValue(new Error("db")),
    ],
  ])("sends nothing, never throws and still waits out the floor when %s", async (_, arrange) => {
    arrange();
    expect(await timedSend()).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();
  });

  test("sends nothing for a type other than sign-in", async () => {
    expect(await timedSend("forget-password")).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();
  });

  test.each([
    ["throws", () => vi.mocked(sendSignInCodeEmail).mockRejectedValue(new Error(`bounce for ${email}`))],
    ["reports not sent", () => vi.mocked(sendSignInCodeEmail).mockResolvedValue(false)],
  ])("resolves normally after the floor when the sender %s", async (_, arrange) => {
    arrange();
    expect(await timedSend()).toBeGreaterThanOrEqual(FLOOR_MS - SLACK_MS);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  test("waits for the send itself to finish before resolving", async () => {
    let delivered = false;
    vi.mocked(sendSignInCodeEmail).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, FLOOR_MS * 2));
      delivered = true;
      return true;
    });
    await sendEmailCodeGated({ email, otp, type: "sign-in" });
    expect(delivered).toBe(true);
  });

  test("measures the floor from the request start the hook recorded", async () => {
    const request = new Request("https://app.example.test/api/auth/email-otp/send-verification-otp");
    // The hook already spent the whole floor (e.g. on the admission and quota lookups).
    markEmailCodeSendStart(request, Date.now() - FLOOR_MS);
    expect(await timedSend("sign-in", { request })).toBeLessThan(FLOOR_MS / 2);
  });

  test("never logs the address or the code", async () => {
    await timedSend();
    vi.mocked(sendSignInCodeEmail).mockRejectedValueOnce(new Error(`bounce for ${email} code ${otp}`));
    await timedSend();
    vi.mocked(isEmailCodeRecipientAdmitted).mockResolvedValueOnce(false);
    await timedSend();
    await timedSend("forget-password");

    const logged = loggedText();
    expect(logged).toContain("auth_email_code_issued");
    expect(logged).toContain("auth_email_code_send_failed");
    expect(logged).not.toContain(email);
    expect(logged).not.toContain("person");
    expect(logged).not.toContain(otp);
  });
});
