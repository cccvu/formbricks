import { beforeEach, describe, expect, test, vi } from "vitest";
import { sendAccountCodeEmail } from "./index";

const { sendEmail, getTranslate } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  getTranslate: vi.fn(),
}));
vi.mock("@/modules/email/lib/send-email", () => ({ sendEmail }));
// The real `@formbricks/email` render runs, so the HTML and text asserted below are what would be sent.
vi.mock("@/lingodotdev/server", () => ({ getTranslate }));

const translations: Record<string, string> = {
  "emails.account_code_email_expiry": "This code expires in {minutes} minutes and can be used once.",
  "emails.account_code_delete_account_subject": "Your account deletion code",
  "emails.account_code_delete_account_heading": "Your account deletion code",
  "emails.account_code_delete_account_text": "Enter this code to permanently delete your account.",
  "emails.account_code_delete_account_did_not_request": "Never share this code.",
  "emails.account_code_confirm_email_change_subject": "Your email change code",
  "emails.account_code_confirm_email_change_heading": "Your email change code",
  "emails.account_code_confirm_email_change_text":
    "Someone asked to change the email address of this account.",
  "emails.account_code_confirm_email_change_did_not_request": "Never share this code.",
  "emails.account_code_verify_new_email_subject": "Verify your new email address",
  "emails.account_code_verify_new_email_heading": "Verify your new email address",
  "emails.account_code_verify_new_email_text": "Enter this code to make this the new email address.",
  "emails.account_code_verify_new_email_did_not_request": "Never share this code.",
};
const t = (key: string, replacements: Record<string, string> = {}) =>
  Object.entries(replacements).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    translations[key] ?? key
  );

const to = "person@example.com";
const code = "48207135";
const sentEmail = () => sendEmail.mock.calls[0][0];

describe("sendAccountCodeEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTranslate.mockResolvedValue(t);
    sendEmail.mockResolvedValue(true);
  });

  // Each purpose has its own email type, so each gets its own per-recipient backstop.
  test.each([
    ["delete_account", "account_deletion_code", "Your account deletion code"],
    ["confirm_email_change", "email_change_current_code", "Your email change code"],
    ["verify_new_email", "email_change_new_code", "Verify your new email address"],
  ] as const)(
    "%s goes out as %s, with the code in the body and never in the subject",
    async (purpose, emailType, subject) => {
      await sendAccountCodeEmail({ to, code, purpose, locale: "en-US", actorUserId: "user-1" });

      expect(sendEmail).toHaveBeenCalledOnce();
      const sent = sentEmail();
      expect(sent).toMatchObject({
        emailType,
        to,
        subject,
        auditContext: { trigger: "user", actorUserId: "user-1" },
      });
      expect(sent.subject).not.toContain(code);
      expect(sent.html).toContain(`>${code}<`);
      expect(sent.html).toContain("This code expires in 10 minutes and can be used once.");
      expect(sent.text).toContain(code);
    }
  );

  test("without an actor it is attributed to the system", async () => {
    await sendAccountCodeEmail({ to, code, purpose: "verify_new_email" });
    expect(sentEmail().auditContext).toEqual({ trigger: "system" });
  });

  test.each([
    ["a supported locale", "de-DE", "de-DE"],
    ["no locale", undefined, "en-US"],
    ["an unsupported locale", "../../etc/passwd", "en-US"],
  ])("translates with %s", async (_name, locale, expected) => {
    await sendAccountCodeEmail({ to, code, purpose: "delete_account", locale });
    expect(getTranslate).toHaveBeenCalledWith(expected);
  });

  test("lets a send failure reach the caller", async () => {
    const failure = new Error("smtp down");
    sendEmail.mockRejectedValue(failure);
    await expect(sendAccountCodeEmail({ to, code, purpose: "delete_account" })).rejects.toBe(failure);
  });
});
