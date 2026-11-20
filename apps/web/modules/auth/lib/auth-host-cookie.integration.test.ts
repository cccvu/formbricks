import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@formbricks/database";
import { resetDb } from "@/integration/reset-db";
import { auth } from "@/modules/auth/lib/auth";
import { SESSION_TOKEN_COOKIE_NAME } from "@/modules/auth/lib/auth-cookies";
import { getProxySessionFromCookieHeader } from "@/modules/auth/lib/proxy-session";

/**
 * The auth cookies of an HTTPS deployment, from the real Better Auth handler: every one is a `__Host-`
 * cookie (`Secure`, `Path=/`, no `Domain`), so only this exact host can set it. A `__Secure-` or
 * unprefixed cookie could be set from a sibling subdomain ("cookie tossing").
 *
 * The rest of the integration suite runs over http, where these names are unprefixed; this file points
 * every auth URL at https before anything reads the env.
 */
const BASE_URL = "https://forms.example.test";

const { savedEnv } = vi.hoisted(() => {
  const names = ["BETTER_AUTH_URL", "NEXTAUTH_URL", "WEBAPP_URL"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "https://forms.example.test";
  return { savedEnv: saved };
});

const PASSWORD = "Correct-Horse1";

type TSetCookie = { name: string; value: string; attributes: string[] };

const parseSetCookie = (setCookie: string): TSetCookie => {
  const [pair, ...attributes] = setCookie.split(";");
  const eq = pair.indexOf("=");
  return {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1),
    attributes: attributes.map((attribute) => attribute.trim()),
  };
};

const setCookiesOf = (response: Response): TSetCookie[] =>
  response.headers.getSetCookie().map(parseSetCookie);

/** What a browser requires before it stores (or overwrites) a `__Host-` cookie. */
const expectHostCookie = (cookie: TSetCookie) => {
  expect(cookie.name).toMatch(/^__Host-formbricks\./);
  expect(cookie.attributes.some((attribute) => /^secure$/i.test(attribute))).toBe(true);
  expect(cookie.attributes.filter((attribute) => /^path=/i.test(attribute))).toEqual(["Path=/"]);
  expect(cookie.attributes.some((attribute) => /^domain=/i.test(attribute))).toBe(false);
};

/** Every cookie Better Auth set: none may fall outside `__Host-`. */
const expectOnlyHostCookies = (response: Response) => {
  const cookies = setCookiesOf(response);
  for (const cookie of cookies) {
    expect(cookie.name).not.toMatch(/^(__Secure-)?formbricks\./);
    if (cookie.name.includes("formbricks")) expectHostCookie(cookie);
  }
  return cookies;
};

const authRequest = (path: string, init: { body?: unknown; cookie?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE_URL };
  if (init.cookie) headers.cookie = init.cookie;
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(init.body ?? {}),
    })
  );
};

/** Sign up, verify, and sign in through the HTTP handler; returns the sign-in response. */
const signIn = async (email: string): Promise<Response> => {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "Host Cookie User" } });
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });

  const response = await authRequest("/sign-in/email", { body: { email, password: PASSWORD } });
  expect(response.status).toBe(200);
  return response;
};

const sessionTokenValue = (response: Response): string => {
  const cookie = setCookiesOf(response).find(({ name }) => name === SESSION_TOKEN_COOKIE_NAME);
  expect(cookie?.value).toBeTruthy();
  return cookie!.value;
};

const getSession = (cookie: string) => auth.api.getSession({ headers: new Headers({ cookie }) });

beforeEach(async () => {
  await resetDb();
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Better Auth cookies on an https deployment (real Better Auth + Postgres)", () => {
  test("sign-in sets only __Host- cookies: Secure, Path=/, no Domain", async () => {
    const response = await signIn("host-cookie-sign-in@example.com");

    const cookies = expectOnlyHostCookies(response);
    expect(cookies.map(({ name }) => name)).toContain("__Host-formbricks.session_token");
  });

  test("the proxy reads the session cookie under the exact name Better Auth uses", async () => {
    expect(SESSION_TOKEN_COOKIE_NAME).toBe("__Host-formbricks.session_token");
    expect((await auth.$context).authCookies.sessionToken.name).toBe(SESSION_TOKEN_COOKIE_NAME);
  });

  test("Better Auth and the proxy accept the __Host- session cookie", async () => {
    const email = "host-cookie-accepted@example.com";
    const value = sessionTokenValue(await signIn(email));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    expect((await getSession(`${SESSION_TOKEN_COOKIE_NAME}=${value}`))?.user.id).toBe(user.id);
    expect((await getProxySessionFromCookieHeader(`${SESSION_TOKEN_COOKIE_NAME}=${value}`))?.userId).toBe(
      user.id
    );
  });

  // The cookie-tossing regression: a sibling subdomain can set these names for this host, carrying a
  // validly signed session (its own). Neither reader may accept them. This is also what a browser still
  // holding a pre-`__Host-` session cookie gets: signed out, consistently, so the proxy and the pages
  // cannot disagree and loop.
  test.each(["__Secure-formbricks.session_token", "formbricks.session_token"])(
    "Better Auth and the proxy both ignore the same signed value under %s",
    async (cookieName) => {
      const value = sessionTokenValue(await signIn("host-cookie-legacy@example.com"));

      expect(await getSession(`${cookieName}=${value}`)).toBeNull();
      expect(await getProxySessionFromCookieHeader(`${cookieName}=${value}`)).toBeNull();
    }
  );

  test("sign-out clears the session with __Host- cookies a browser will accept", async () => {
    const value = sessionTokenValue(await signIn("host-cookie-sign-out@example.com"));

    const response = await authRequest("/sign-out", { cookie: `${SESSION_TOKEN_COOKIE_NAME}=${value}` });
    expect(response.status).toBe(200);

    const cookies = expectOnlyHostCookies(response);
    const cleared = cookies.find(({ name }) => name === SESSION_TOKEN_COOKIE_NAME);
    expect(cleared?.value).toBe("");
    expect(cleared?.attributes).toContain("Max-Age=0");
    expect(await prisma.session.count()).toBe(0);
  });
});
