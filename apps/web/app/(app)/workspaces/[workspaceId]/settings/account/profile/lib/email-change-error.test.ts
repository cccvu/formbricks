import { describe, expect, test } from "vitest";
import { getEmailChangeError } from "./email-change-error";
import {
  EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE,
  EMAIL_CHANGE_INVALID_CODE_MESSAGE,
  EMAIL_CHANGE_SAME_EMAIL_MESSAGE,
} from "./email-change-messages";

describe("getEmailChangeError", () => {
  test.each([
    [{ serverError: EMAIL_CHANGE_INVALID_CODE_MESSAGE }, "invalid_code"],
    [{ serverError: EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE }, "email_in_use"],
    [{ serverError: EMAIL_CHANGE_SAME_EMAIL_MESSAGE }, "same_email"],
    [{ serverError: "Maximum number of requests reached. Please try again later." }, "rate_limited"],
    [{ validationErrors: { code: { _errors: ["Invalid code"] } } }, "invalid_code"],
    [{ validationErrors: { newEmail: { _errors: ["Invalid email"] } } }, "unknown"],
    [{ serverError: "Not authenticated" }, "unknown"],
    [null, "unknown"],
  ])("maps %j to %s", (result, expected) => {
    expect(getEmailChangeError(result)).toBe(expected);
  });
});
