import { beforeEach, describe, expect, test, vi } from "vitest";
import { sendSignInCodeEmail } from "./index";

const { sendEmail, getTranslate } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  getTranslate: vi.fn(),
}));
vi.mock("@/modules/email/lib/send-email", () => ({ sendEmail }));
// The real `@formbricks/email` render runs, so the HTML and text asserted below are what would be sent.
vi.mock("@/lingodotdev/server", () => ({ getTranslate }));

const translations: Record<string, string> = {
  "emails.sign_in_code_email_subject": "Your sign-in code",
  "emails.sign_in_code_email_heading": "Your sign-in code",
  "emails.sign_in_code_email_expiry": "This code expires in {minutes} minutes and can be used once.",
  "emails.sign_in_code_email_did_not_request":
    "If you didn't request it, you can ignore this email. Never share this code.",
};
const t = (key: string, replacements: Record<string, string> = {}) =>
  Object.entries(replacements).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    translations[key] ?? key
  );

const to = "person@example.com";
const code = "48207135";

const sentEmail = () => sendEmail.mock.calls[0][0];

describe("sendSignInCodeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTranslate.mockResolvedValue(t);
    sendEmail.mockResolvedValue(true);
  });

  test("sends the code in the HTML and text parts, but never in the subject", async () => {
    await sendSignInCodeEmail(to, code, "en-US");

    expect(sendEmail).toHaveBeenCalledOnce();
    const { emailType, to: recipient, subject, html, text } = sentEmail();
    expect(emailType).toBe("sign_in_code");
    expect(recipient).toBe(to);
    expect(subject).toBe("Your sign-in code");
    expect(subject).not.toContain(code);
    expect(html).toContain(`>${code}<`);
    expect(html).toContain("This code expires in 10 minutes and can be used once.");
    expect(text).toContain(code);
  });

  test("states the code's real lifetime, derived from EMAIL_CODE_TTL_SECONDS", async () => {
    // A different lifetime must change what the email says, so a hardcoded number cannot drift from it.
    vi.doMock("@/modules/auth/lib/email-code/constants", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/modules/auth/lib/email-code/constants")>()),
      EMAIL_CODE_TTL_SECONDS: 900,
    }));
    try {
      const fresh = await import("./index");
      expect(fresh.SIGN_IN_CODE_VALIDITY_MINUTES).toBe(15);
      await fresh.sendSignInCodeEmail(to, code, "en-US");
      expect(sentEmail().html).toContain("This code expires in 15 minutes and can be used once.");
    } finally {
      vi.doUnmock("@/modules/auth/lib/email-code/constants");
    }
  });

  test.each([true, false])("returns sendEmail's result (%s)", async (sent) => {
    sendEmail.mockResolvedValue(sent);

    await expect(sendSignInCodeEmail(to, code)).resolves.toBe(sent);
  });

  test("lets a send failure reach the caller", async () => {
    const failure = new Error("smtp down");
    sendEmail.mockRejectedValue(failure);

    await expect(sendSignInCodeEmail(to, code)).rejects.toBe(failure);
  });

  test.each([
    ["a supported locale", "de-DE", "de-DE"],
    ["no locale", undefined, "en-US"],
    ["an unsupported locale", "../../etc/passwd", "en-US"],
  ])("translates with %s", async (_name, locale, expected) => {
    await sendSignInCodeEmail(to, code, locale);

    expect(getTranslate).toHaveBeenCalledWith(expected);
  });
});
