import { z } from "zod";
import { ZUserEmail } from "@formbricks/types/user";
import { ACCOUNT_CODE_LENGTH } from "./constants";

/** Longest raw code input accepted before normalizing (8 digits plus generous spacing or dashes). */
const ACCOUNT_CODE_MAX_INPUT_LENGTH = 32;

/**
 * An emailed account-change code as a user types it: spaces and dashes (from copying "1234 5678" or
 * "1234-5678") are dropped, then it must be exactly the code's digits. Shared by the server actions; safe to
 * import on the client.
 */
export const ZAccountCode = z
  .string()
  .max(ACCOUNT_CODE_MAX_INPUT_LENGTH)
  .transform((value) => value.replaceAll(/[\s-]/g, ""))
  .pipe(z.string().regex(new RegExp(`^\\d{${ACCOUNT_CODE_LENGTH}}$`), "Invalid code"));

/** A new email address as typed: trimmed and lowercased (Better Auth's own canonical form), then validated. */
export const ZNewEmailAddress = z.string().max(320).trim().toLowerCase().pipe(ZUserEmail);
