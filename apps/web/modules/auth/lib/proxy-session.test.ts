import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  getProxySession,
  getProxySessionFromCookieHeader,
  getSessionTokenFromRequest,
} from "./proxy-session";

const { TEST_SECRET, mockFindUnique } = vi.hoisted(() => ({
  TEST_SECRET: "proxy-session-test-secret-at-least-32-characters",
  mockFindUnique: vi.fn(),
}));

vi.mock("@formbricks/database", () => ({
  prisma: {
    session: {
      findUnique: mockFindUnique,
    },
  },
}));

// An https deployment, so the session cookie is `__Host-formbricks.session_token` (auth-cookies.ts).
vi.mock("@/lib/env", () => ({
  env: { BETTER_AUTH_SECRET: TEST_SECRET, BETTER_AUTH_URL: "https://forms.example.test" },
}));

const SESSION_COOKIE = "__Host-formbricks.session_token";

// Mirror better-call's serializeSignedCookie: `${token}.${base64(HMAC-SHA256(token, secret))}`.
const sign = (token: string, secret = TEST_SECRET): string =>
  `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;

const SELECT = {
  userId: true,
  expires: true,
  user: { select: { isActive: true } },
};

const createRequest = (cookies: Record<string, string> = {}) => ({
  cookies: {
    get: (name: string) => {
      const value = cookies[name];
      return value ? { value } : undefined;
    },
  },
});

describe("proxy-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("extracts the verified session token from a signed Better Auth cookie", () => {
    const request = createRequest({ [SESSION_COOKIE]: sign("secure-token") });
    expect(getSessionTokenFromRequest(request)).toBe("secure-token");
  });

  // Cookie tossing: a sibling subdomain can set these names for this host, with a validly signed value
  // (its own session). Better Auth ignores them, so the proxy must too, on both read paths.
  test.each(["formbricks.session_token", "__Secure-formbricks.session_token"])(
    "ignores a validly signed %s cookie, which a sibling subdomain could set",
    async (cookieName) => {
      mockFindUnique.mockResolvedValue({
        userId: "attacker",
        expires: new Date(Date.now() + 60_000),
        user: { isActive: true },
      });

      expect(await getProxySession(createRequest({ [cookieName]: sign("attacker-token") }))).toBeNull();
      expect(
        await getProxySessionFromCookieHeader(`${cookieName}=${encodeURIComponent(sign("attacker-token"))}`)
      ).toBeNull();
      expect(mockFindUnique).not.toHaveBeenCalled();
    }
  );

  test("rejects a tampered cookie signature without hitting the database", async () => {
    const request = createRequest({
      [SESSION_COOKIE]: "valid-token.not-a-valid-signature",
    });
    expect(getSessionTokenFromRequest(request)).toBeNull();
    expect(await getProxySession(request)).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test("returns null when no session cookie is present", async () => {
    const session = await getProxySession(createRequest());
    expect(session).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test("returns null when the session is expired", async () => {
    mockFindUnique.mockResolvedValue({
      userId: "user-1",
      expires: new Date(Date.now() - 60_000),
      user: { isActive: true },
    });

    const request = createRequest({ [SESSION_COOKIE]: sign("expired-token") });
    const session = await getProxySession(request);

    expect(session).toBeNull();
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { sessionToken: "expired-token" }, select: SELECT });
  });

  test("returns null when the session belongs to an inactive user", async () => {
    mockFindUnique.mockResolvedValue({
      userId: "user-1",
      expires: new Date(Date.now() + 60_000),
      user: { isActive: false },
    });

    const request = createRequest({ [SESSION_COOKIE]: sign("inactive-user-token") });
    expect(await getProxySession(request)).toBeNull();
  });

  test("returns the session when the signed cookie maps to a valid session", async () => {
    const validSession = {
      userId: "user-1",
      expires: new Date(Date.now() + 60_000),
      user: { isActive: true },
    };
    mockFindUnique.mockResolvedValue(validSession);

    const request = createRequest({ [SESSION_COOKIE]: sign("valid-token") });
    const session = await getProxySession(request);

    expect(session).toEqual(validSession);
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { sessionToken: "valid-token" }, select: SELECT });
  });

  test("resolves the same active session from a raw Cookie header", async () => {
    const validSession = {
      userId: "user-1",
      expires: new Date(Date.now() + 60_000),
      user: { isActive: true },
    };
    mockFindUnique.mockResolvedValue(validSession);

    const cookieHeader = `other=1; ${SESSION_COOKIE}=${encodeURIComponent(sign("header-token"))}`;

    expect(await getProxySessionFromCookieHeader(cookieHeader)).toEqual(validSession);
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { sessionToken: "header-token" }, select: SELECT });
  });

  test("returns null from a Cookie header without a verified session cookie, without a query", async () => {
    expect(await getProxySessionFromCookieHeader(null)).toBeNull();
    expect(await getProxySessionFromCookieHeader(`${SESSION_COOKIE}=forged.signature`)).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
