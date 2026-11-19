import { describe, expect, test } from "vitest";
import { EMAIL_CODE_DEVICE_TTL_SECONDS } from "./constants";
import { createDeviceToken, getRecipientTag, isValidDeviceToken } from "./tokens";

const address = "owner@example.com";
const now = Date.UTC(2026, 0, 1);

describe("getRecipientTag", () => {
  test("is stable across case and surrounding whitespace", () => {
    expect(getRecipientTag("  Owner@Example.COM ")).toBe(getRecipientTag(address));
  });

  test("differs between addresses", () => {
    expect(getRecipientTag("other@example.com")).not.toBe(getRecipientTag(address));
  });

  test("never contains the address or any part of it", () => {
    const tag = getRecipientTag(address);
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    expect(tag).not.toContain("owner");
    expect(tag).not.toContain("example");
  });
});

describe("device token", () => {
  test("is valid for its own address only (case-insensitively)", () => {
    const token = createDeviceToken(address, now);
    expect(isValidDeviceToken(token, address, now)).toBe(true);
    expect(isValidDeviceToken(token, " OWNER@example.com", now)).toBe(true);
    expect(isValidDeviceToken(token, "other@example.com", now)).toBe(false);
  });

  test("expires after EMAIL_CODE_DEVICE_TTL_SECONDS", () => {
    const token = createDeviceToken(address, now);
    const ttlMs = EMAIL_CODE_DEVICE_TTL_SECONDS * 1000;
    expect(isValidDeviceToken(token, address, now + ttlMs - 1000)).toBe(true);
    expect(isValidDeviceToken(token, address, now + ttlMs)).toBe(false);
  });

  test("is refused when tampered with", () => {
    const token = createDeviceToken(address, now);
    const [expiresAt, mac] = token.split(".");
    const flipped = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    // A later expiry with the original MAC must not verify: the expiry is part of what is signed.
    expect(isValidDeviceToken(`${Number(expiresAt) + 1}.${mac}`, address, now)).toBe(false);
    expect(isValidDeviceToken(`${expiresAt}.${flipped}`, address, now)).toBe(false);
    expect(isValidDeviceToken(`${expiresAt}.${mac}.extra`, address, now)).toBe(false);
    expect(isValidDeviceToken(`${expiresAt}.`, address, now)).toBe(false);
    expect(isValidDeviceToken(`x${expiresAt}.${mac}`, address, now)).toBe(false);
  });

  test("is refused when empty or oversized", () => {
    const token = createDeviceToken(address, now);
    expect(isValidDeviceToken(undefined, address, now)).toBe(false);
    expect(isValidDeviceToken(null, address, now)).toBe(false);
    expect(isValidDeviceToken("", address, now)).toBe(false);
    expect(isValidDeviceToken(`${token}${"A".repeat(129 - token.length)}`, address, now)).toBe(false);
  });
});
