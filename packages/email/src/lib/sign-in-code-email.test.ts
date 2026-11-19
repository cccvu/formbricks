import { describe, expect, test } from "vitest";
import { renderSignInCodeEmail } from "../index";
import { t } from "./mock-translate";

const code = "48207135";
const render = () => renderSignInCodeEmail({ code, validityInMinutes: 10, t });

// The DOCTYPE names the XHTML DTD by URL; that is a declaration, not something a mail client fetches or a
// reader can click, so it is the one URL the document may carry.
const withoutDoctype = (html: string): string => html.replace(/^<!DOCTYPE[^>]*>/i, "");

describe("renderSignInCodeEmail", () => {
  test("shows the code, how long it lasts and what to do if it was not requested", async () => {
    const { html } = await render();

    expect(html).toMatch(/^<!DOCTYPE html/i);
    expect(html).toContain(`>${code}<`);
    expect(html).toContain("This code expires in 10 minutes and can be used once.");
    expect(html).toContain("Never share this code.");
    expect(html).not.toMatch(/\b(?:emails|common)\.[a-z0-9_]+/);
  });

  // Nothing to click and nothing to fetch: a phisher has no link to imitate, and opening the mail tells
  // nobody it was read.
  test("carries no link, image, remote resource or URL", async () => {
    const { html } = await render();
    const body = withoutDoctype(html);

    expect(body).not.toMatch(/href=/i);
    expect(body).not.toMatch(/src=/i);
    expect(body).not.toMatch(/https?:\/\//i);
  });

  test("produces a plain-text part that carries the code", async () => {
    const { text } = await render();

    expect(text).toContain(code);
    expect(text).toContain("This code expires in 10 minutes and can be used once.");
    expect(text).not.toMatch(/https?:\/\/|</);
  });
});
