import { describe, expect, test } from "vitest";
import { ZAccountCode } from "./account-code-input";
import {
  ACCOUNT_CODE_TTL_MINUTES,
  isCompleteAccountCode,
  isRateLimitServerError,
  normalizeAccountCode,
} from "./account-code-ui";

describe("account code client helpers", () => {
  test.each([
    ["1234 5678", "12345678"],
    ["1234-5678", "12345678"],
    [" 12 34-56 78 ", "12345678"],
    ["123456789", "12345678"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeAccountCode(input)).toBe(expected);
  });

  test("a normalized code is what the server schema accepts", () => {
    const typed = "1234 - 5678";
    expect(ZAccountCode.parse(typed)).toBe(normalizeAccountCode(typed));
  });

  test.each([
    ["12345678", true],
    ["1234567", false],
    ["1234567a", false],
    ["", false],
  ])("isCompleteAccountCode(%j) is %s", (code, expected) => {
    expect(isCompleteAccountCode(code)).toBe(expected);
  });

  test("recognizes only the rate limiter's message", () => {
    expect(isRateLimitServerError("Maximum number of requests reached. Please try again later.")).toBe(true);
    expect(isRateLimitServerError("Something went wrong")).toBe(false);
    expect(isRateLimitServerError(undefined)).toBe(false);
  });

  test("states the code lifetime in minutes", () => {
    expect(ACCOUNT_CODE_TTL_MINUTES).toBe(10);
  });
});
