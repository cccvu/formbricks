import { describe, expect, test } from "vitest";
import { type TAccountCodePurpose, getAccountCodeEmailSubject, renderAccountCodeEmail } from "../index";
import { t } from "./mock-translate";

const code = "48207135";
const purposes: TAccountCodePurpose[] = ["delete_account", "confirm_email_change", "verify_new_email"];
const render = (purpose: TAccountCodePurpose) =>
  renderAccountCodeEmail({ code, validityInMinutes: 10, purpose, t });

// The DOCTYPE names the XHTML DTD by URL; that is a declaration, not something a mail client fetches or a
// reader can click, so it is the one URL the document may carry.
const withoutDoctype = (html: string): string => html.replace(/^<!DOCTYPE[^>]*>/i, "");

describe("renderAccountCodeEmail", () => {
  test.each(purposes)("%s: shows the code, its lifetime and the never-share warning", async (purpose) => {
    const { html } = await render(purpose);

    expect(html).toMatch(/^<!DOCTYPE html/i);
    expect(html).toContain(`>${code}<`);
    expect(html).toContain("This code expires in 10 minutes and can be used once.");
    expect(html).toContain("Never share this code.");
    // Every key resolved: an unknown key would come through as its own name.
    expect(html).not.toMatch(/\b(?:emails|common)\.[a-z0-9_]+/);
  });

  // The mail to the current address is also the notice that someone is trying to move the account.
  // Read from the text part: the HTML escapes the apostrophes.
  test("the current-address email says someone asked to change the address, and how to refuse", async () => {
    const { text } = await render("confirm_email_change");

    expect(text).toContain("Someone asked to change the email address of this account.");
    expect(text).toContain("If it wasn't you, ignore this email");
  });

  test("the deletion email says the deletion is permanent", async () => {
    const { text } = await render("delete_account");

    expect(text).toContain("permanently delete your account");
    expect(text).toContain("can't be undone");
  });

  // Nothing to click and nothing to fetch: a phisher has no link to imitate, and opening the mail tells
  // nobody it was read.
  test.each(purposes)("%s: carries no link, image, remote resource or URL", async (purpose) => {
    const body = withoutDoctype((await render(purpose)).html);

    expect(body).not.toMatch(/href=/i);
    expect(body).not.toMatch(/src=/i);
    expect(body).not.toMatch(/https?:\/\//i);
  });

  test.each(purposes)("%s: produces a plain-text part that carries the code", async (purpose) => {
    const { text } = await render(purpose);

    expect(text).toContain(code);
    expect(text).toContain("This code expires in 10 minutes and can be used once.");
    expect(text).not.toMatch(/https?:\/\/|</);
  });
});

describe("getAccountCodeEmailSubject", () => {
  test.each(purposes)("%s: has its own subject, which never carries a code", (purpose) => {
    const subject = getAccountCodeEmailSubject(purpose, t);

    expect(subject).not.toMatch(/^emails\./);
    expect(subject).not.toMatch(/\d/);
  });

  test("the three purposes have distinct subjects", () => {
    const subjects = new Set(purposes.map((purpose) => getAccountCodeEmailSubject(purpose, t)));
    expect(subjects.size).toBe(purposes.length);
  });
});
