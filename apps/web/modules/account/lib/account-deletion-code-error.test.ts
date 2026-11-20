import { describe, expect, test } from "vitest";
import {
  ACCOUNT_DELETION_INVALID_CODE_MESSAGE,
  ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE,
} from "@/modules/account/constants";
import { getAccountDeletionCodeError } from "./account-deletion-code-error";

describe("getAccountDeletionCodeError", () => {
  test.each([
    [{ serverError: ACCOUNT_DELETION_INVALID_CODE_MESSAGE }, "invalid_code"],
    [{ serverError: ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE }, "sole_owner"],
    [{ serverError: "Maximum number of requests reached. Please try again later." }, "rate_limited"],
    [{ validationErrors: { code: { _errors: ["Invalid code"] } } }, "invalid_code"],
    [{ serverError: "Something went wrong while executing the operation." }, "unknown"],
    [undefined, "unknown"],
  ])("maps %j to %s", (result, expected) => {
    expect(getAccountDeletionCodeError(result)).toBe(expected);
  });
});
