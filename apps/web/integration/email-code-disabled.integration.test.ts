import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { closeRedis, flushRedis, request, sendCode, signIn } from "@/integration/email-code-helpers";
import { resetDb } from "@/integration/reset-db";
import { EMAIL_CODE_AUTH_ENABLED } from "@/lib/constants";
import { sendSignInCodeEmail } from "@/modules/email";

/** With EMAIL_CODE_AUTH_ENABLED unset the plugin is not mounted at all: nothing under it answers. */
vi.hoisted(() => {
  delete process.env.EMAIL_CODE_AUTH_ENABLED;
});

beforeEach(async () => {
  await resetDb();
  await flushRedis();
  vi.clearAllMocks();
});

afterAll(closeRedis);

describe("email-code sign-in switched off", () => {
  test("the flag is off in this file", () => {
    expect(EMAIL_CODE_AUTH_ENABLED).toBe(false);
  });

  test("send and sign-in answer 404 and mail nothing", async () => {
    expect((await sendCode("person@example.com")).status).toBe(404);
    expect((await signIn("person@example.com", "12345678")).status).toBe(404);
    expect((await request("/email-otp/verify-email", { email: "person@example.com", otp: "1" })).status).toBe(
      404
    );
    expect(sendSignInCodeEmail).not.toHaveBeenCalled();
  });
});
