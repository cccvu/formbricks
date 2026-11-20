import type { BetterAuthOptions } from "better-auth";
import { createCookieGetter } from "better-auth/cookies";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The cookie names and attributes come from Better Auth's own getter, run over the shared settings
 * `auth.ts` passes it. A Better Auth upgrade that changes how they are derived (it would only take
 * `useSecureCookies` being honoured differently) fails here rather than in a browser.
 */
const constantsMock = { AUTH_URL: undefined as string | undefined };
const envMock = { WEBAPP_URL: undefined as string | undefined };

vi.mock("@/lib/constants", () => constantsMock);
vi.mock("@/lib/env", () => ({ env: envMock }));

const BASE_URL = "https://forms.example.test";

const load = async (authUrl: string) => {
  constantsMock.AUTH_URL = authUrl;
  vi.resetModules();
  const cookies = await import("./auth-cookies");
  const guard = await import("./auth-cookie-guard");
  return { ...cookies, ...guard };
};

/** The cookie part of `auth.ts`'s `advanced` options. */
const authOptions = (
  cookies: Awaited<ReturnType<typeof load>>,
  advanced: BetterAuthOptions["advanced"] = {}
): BetterAuthOptions => ({
  baseURL: BASE_URL,
  advanced: {
    useSecureCookies: false,
    cookiePrefix: cookies.AUTH_COOKIE_PREFIX,
    defaultCookieAttributes: cookies.AUTH_DEFAULT_COOKIE_ATTRIBUTES,
    cookies: { state: { attributes: { maxAge: 600 } } },
    ...advanced,
  },
});

beforeEach(() => {
  envMock.WEBAPP_URL = undefined;
});

/** Every cookie Better Auth 1.7 and the plugins `auth.ts` mounts create through `cookiePrefix`. */
const AUTH_COOKIES = [
  "session_token",
  "session_data",
  "dont_remember",
  "account_data",
  "state",
  "oauth_state",
  "two_factor",
  "trust_device",
];

describe("Better Auth cookies on https", () => {
  test.each(AUTH_COOKIES)("%s is a valid __Host- cookie", async (cookieName) => {
    const cookies = await load(BASE_URL);

    const { name, attributes } = createCookieGetter(authOptions(cookies))(cookieName);

    expect(name).toBe(`__Host-formbricks.${cookieName}`);
    expect(name).not.toContain("__Secure-");
    expect(attributes.secure).toBe(true);
    expect(attributes.path).toBe("/");
    expect(attributes.domain).toBeUndefined();
  });

  test("the guard covers every cookie checked above", async () => {
    const { GUARDED_AUTH_COOKIES } = await load(BASE_URL);

    expect([...GUARDED_AUTH_COOKIES].sort()).toEqual([...AUTH_COOKIES].sort());
  });

  test("the session cookie Better Auth sets is the one the proxy reads", async () => {
    const cookies = await load(BASE_URL);

    expect(createCookieGetter(authOptions(cookies))("session_token").name).toBe(
      cookies.SESSION_TOKEN_COOKIE_NAME
    );
  });
});

describe("assertHostPrefixedAuthCookies", () => {
  test("accepts the configuration auth.ts uses", async () => {
    const cookies = await load(BASE_URL);

    expect(() => cookies.assertHostPrefixedAuthCookies(authOptions(cookies))).not.toThrow();
  });

  test("refuses useSecureCookies, which prepends __Secure- to the __Host- prefix", async () => {
    const cookies = await load(BASE_URL);

    expect(() =>
      cookies.assertHostPrefixedAuthCookies(authOptions(cookies, { useSecureCookies: true }))
    ).toThrow(/__Secure-__Host-formbricks\.session_token: name is not __Host- prefixed/);
  });

  test("refuses a cookie name outside the __Host- prefix", async () => {
    const cookies = await load(BASE_URL);

    expect(() =>
      cookies.assertHostPrefixedAuthCookies(authOptions(cookies, { cookiePrefix: "formbricks" }))
    ).toThrow(/formbricks\.session_token: name is not __Host- prefixed/);
  });

  test("refuses a cookie that is not Secure", async () => {
    const cookies = await load(BASE_URL);
    const options = authOptions(cookies, {
      defaultCookieAttributes: { ...cookies.AUTH_DEFAULT_COOKIE_ATTRIBUTES, secure: false },
    });

    expect(() => cookies.assertHostPrefixedAuthCookies(options)).toThrow(/not Secure/);
  });

  test("refuses a path other than /", async () => {
    const cookies = await load(BASE_URL);
    const options = authOptions(cookies, {
      cookies: { state: { attributes: { maxAge: 600, path: "/api/auth" } } },
    });

    expect(() => cookies.assertHostPrefixedAuthCookies(options)).toThrow(
      /__Host-formbricks\.state: Path=\/api\/auth/
    );
  });

  test("refuses a Domain, which would let every subdomain read and set the cookie", async () => {
    const cookies = await load(BASE_URL);
    const options = authOptions(cookies, {
      crossSubDomainCookies: { enabled: true, domain: "example.test" },
    });

    expect(() => cookies.assertHostPrefixedAuthCookies(options)).toThrow(/Domain=example\.test/);
  });

  test("does nothing over http, where no cookie can be Secure", async () => {
    const cookies = await load("http://localhost:3000");

    expect(cookies.AUTH_COOKIE_PREFIX).toBe("formbricks");
    expect(() =>
      cookies.assertHostPrefixedAuthCookies(authOptions(cookies, { useSecureCookies: true }))
    ).not.toThrow();
  });
});
