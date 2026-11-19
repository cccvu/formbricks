import { describe, expect, test } from "vitest";
import {
  getEmailCodeSetupSignupRedirectUrl,
  getEmailCodeSignupRedirectUrl,
} from "@/modules/auth/signup/lib/email-code-redirect";

const parse = (url: string) => new URL(url, "https://app.example.com");

describe("getEmailCodeSignupRedirectUrl", () => {
  test("sends a plain sign-up visit to the login page", () => {
    expect(getEmailCodeSignupRedirectUrl({})).toBe("/auth/login");
    expect(getEmailCodeSignupRedirectUrl({ inviteToken: null, email: null })).toBe("/auth/login");
  });

  test("turns the invite token into an encoded callbackUrl back to the invite page", () => {
    const url = getEmailCodeSignupRedirectUrl({ inviteToken: "abc.def-ghi_jkl" });

    expect(url).toBe("/auth/login?callbackUrl=%2Finvite%3Ftoken%3Dabc.def-ghi_jkl");
    expect(parse(url).pathname).toBe("/auth/login");
    expect(parse(url).searchParams.get("callbackUrl")).toBe("/invite?token=abc.def-ghi_jkl");
    expect(parse(url).searchParams.has("inviteToken")).toBe(false);
  });

  test("encodes characters that would otherwise break out of the callbackUrl", () => {
    const url = getEmailCodeSignupRedirectUrl({ inviteToken: "a&callbackUrl=https://evil.example#x" });
    const params = parse(url).searchParams;

    expect(params.getAll("callbackUrl")).toHaveLength(1);
    const callback = parse(params.get("callbackUrl") ?? "");
    expect(callback.pathname).toBe("/invite");
    expect(callback.searchParams.get("token")).toBe("a&callbackUrl=https://evil.example#x");
  });

  test("carries the email over so the login form is prefilled", () => {
    const url = getEmailCodeSignupRedirectUrl({ inviteToken: "tok", email: "ada+x@example.com" });
    const params = parse(url).searchParams;

    expect(params.get("callbackUrl")).toBe("/invite?token=tok");
    expect(params.get("email")).toBe("ada+x@example.com");
  });
});

describe("getEmailCodeSetupSignupRedirectUrl", () => {
  test("continues setup at organization creation after sign-in", () => {
    expect(getEmailCodeSetupSignupRedirectUrl()).toBe(
      "/auth/login?callbackUrl=%2Fsetup%2Forganization%2Fcreate"
    );
  });
});
