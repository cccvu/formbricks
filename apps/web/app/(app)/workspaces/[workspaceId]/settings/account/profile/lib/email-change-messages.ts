/**
 * The messages the email-change actions answer with (email-code sign-in), one constant each so the action
 * that throws and the client that matches them to localized text cannot drift apart. Safe to import on the
 * client.
 */

/** A wrong, expired or burned (5 wrong guesses) code, for either step. One message, so it reveals nothing. */
export const EMAIL_CHANGE_INVALID_CODE_MESSAGE = "This code is invalid or has expired. Request a new one.";

/**
 * The new address belongs to another account. Only ever answered after a valid code from that address,
 * so it tells nothing to someone who does not hold that mailbox (Better Auth's own wording).
 */
export const EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE = "Email already in use";

/** The new address is the account's current one. */
export const EMAIL_CHANGE_SAME_EMAIL_MESSAGE = "This is already your email address.";
