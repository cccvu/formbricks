import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable constants mock so each test can vary whether a secret is resolved and which scheme the auth
// URL uses. `AUTH_SECRET` is the already-resolved BETTER_AUTH_SECRET/NEXTAUTH_SECRET value — which of the
// two wins is constants.ts's business and is covered by lib/constants.test.ts. Mocking the raw env vars
// here would no longer steer this module at all. `AUTH_URL` decides the cookie name (auth-cookies.ts).
// ENCRYPTION_KEY is reached transitively: lib/crypto.ts (constantTimeEqual) reads it at module load.
const { mockConstants } = vi.hoisted(() => ({
  mockConstants: { ENCRYPTION_KEY: "0".repeat(64) } as {
    AUTH_SECRET?: string;
    AUTH_URL?: string;
    ENCRYPTION_KEY: string;
  },
}));
vi.mock("@/lib/constants", () => mockConstants);
vi.mock("@/lib/env", () => ({ env: {} }));

const HTTPS_URL = "https://forms.example.test";
const HOST_COOKIE = "__Host-formbricks.session_token";
const SECURE_COOKIE = "__Secure-formbricks.session_token";
const DEV_COOKIE = "formbricks.session_token";

// Mirror better-call's serializeSignedCookie: `${token}.${base64(HMAC-SHA256(token, secret))}`.
const sign = (token: string, secret: string): string =>
  `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;

const storeWith = (name: string, value: string) => ({
  get: (n: string) => (n === name ? { value } : undefined),
});

/** The module as loaded for a deployment whose auth URL is `authUrl`. */
const load = async (authUrl: string = HTTPS_URL) => {
  mockConstants.AUTH_URL = authUrl;
  vi.resetModules();
  return await import("./session-cookie");
};

beforeEach(() => {
  mockConstants.AUTH_SECRET = undefined;
});

describe("Better Auth session-cookie verification", () => {
  const token = "abc123sessioncuid2";
  const BA_SECRET = "better-auth-secret-at-least-32-chars!!";
  const OTHER_SECRET = "some-other-secret-64-chars-or-so-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  test("verifies a cookie signed with the resolved auth secret", async () => {
    mockConstants.AUTH_SECRET = BA_SECRET;
    const { getSessionTokenFromCookieStore } = await load();
    expect(getSessionTokenFromCookieStore(storeWith(HOST_COOKIE, sign(token, BA_SECRET)))).toBe(token);
  });

  test("rejects a cookie signed with any other secret (regression: /↔/auth/login loop)", async () => {
    // The redirect-loop bug in its general form: if this module ever verifies with a secret other than
    // the one auth.ts signs with, it rejects every valid session and bounces the user between / and
    // /auth/login. Both sides now read the same resolved constant, so the only way they can diverge is
    // if one of them stops doing so.
    mockConstants.AUTH_SECRET = BA_SECRET;
    const { getSessionTokenFromCookieStore } = await load();
    expect(getSessionTokenFromCookieStore(storeWith(HOST_COOKIE, sign(token, OTHER_SECRET)))).toBeNull();
  });

  test("fails closed when no secret is set", async () => {
    const { getSessionTokenFromCookieStore } = await load();
    expect(getSessionTokenFromCookieStore(storeWith(HOST_COOKIE, sign(token, "some-secret")))).toBeNull();
  });

  test("rejects a tampered signature", async () => {
    mockConstants.AUTH_SECRET = BA_SECRET;
    const { getSessionTokenFromCookieStore } = await load();
    const tampered = `${token}.${createHmac("sha256", "wrong-secret").update(token).digest("base64")}`;
    expect(getSessionTokenFromCookieStore(storeWith(HOST_COOKIE, tampered))).toBeNull();
  });

  test("returns null when no Better Auth session cookie is present", async () => {
    mockConstants.AUTH_SECRET = BA_SECRET;
    const { getSessionTokenFromCookieStore } = await load();
    expect(getSessionTokenFromCookieStore(storeWith("unrelated-cookie", "x"))).toBeNull();
  });

  test("reads and verifies from a Cookie header (and null for no header)", async () => {
    mockConstants.AUTH_SECRET = BA_SECRET;
    const { getSessionTokenFromCookieHeader } = await load();
    const cookie = sign(token, BA_SECRET);
    expect(getSessionTokenFromCookieHeader(`foo=1; ${HOST_COOKIE}=${cookie}; bar=2`)).toBe(token);
    expect(getSessionTokenFromCookieHeader(null)).toBeNull();
  });

  // The cookie-tossing regression. A sibling subdomain can set any cookie name without `__Host-` for
  // this host (`Domain=` the parent domain), and a validly signed value is easy to get: the attacker's
  // own session. Better Auth only reads the `__Host-` name, so accepting either of these here would sign
  // the victim into the attacker's account wherever the proxy decides, and only there.
  describe.each([
    ["unprefixed", DEV_COOKIE],
    ["__Secure-", SECURE_COOKIE],
  ])("on https, a validly signed %s cookie", (_label, cookieName) => {
    test("is ignored by the cookie-store reader", async () => {
      mockConstants.AUTH_SECRET = BA_SECRET;
      const { getSessionTokenFromCookieStore } = await load();
      expect(getSessionTokenFromCookieStore(storeWith(cookieName, sign(token, BA_SECRET)))).toBeNull();
    });

    test("is ignored by the Cookie header reader", async () => {
      mockConstants.AUTH_SECRET = BA_SECRET;
      const { getSessionTokenFromCookieHeader } = await load();
      expect(getSessionTokenFromCookieHeader(`${cookieName}=${sign(token, BA_SECRET)}`)).toBeNull();
    });

    test("does not stand in for the __Host- cookie beside it", async () => {
      // A planted cookie sent first must not displace the real one, and must never be what is returned.
      mockConstants.AUTH_SECRET = BA_SECRET;
      const { getSessionTokenFromCookieHeader } = await load();
      const header = `${cookieName}=${sign("attacker-token", BA_SECRET)}; ${HOST_COOKIE}=${sign(token, BA_SECRET)}`;
      expect(getSessionTokenFromCookieHeader(header)).toBe(token);
    });
  });

  describe("on http (local/dev)", () => {
    test("reads the unprefixed cookie from a cookie store and a Cookie header", async () => {
      mockConstants.AUTH_SECRET = BA_SECRET;
      const { getSessionTokenFromCookieHeader, getSessionTokenFromCookieStore } =
        await load("http://localhost:3000");
      expect(getSessionTokenFromCookieStore(storeWith(DEV_COOKIE, sign(token, BA_SECRET)))).toBe(token);
      expect(getSessionTokenFromCookieHeader(`${DEV_COOKIE}=${sign(token, BA_SECRET)}`)).toBe(token);
    });

    test("ignores the __Host- name, which a browser would not store over http", async () => {
      mockConstants.AUTH_SECRET = BA_SECRET;
      const { getSessionTokenFromCookieStore } = await load("http://localhost:3000");
      expect(getSessionTokenFromCookieStore(storeWith(HOST_COOKIE, sign(token, BA_SECRET)))).toBeNull();
    });
  });
});
