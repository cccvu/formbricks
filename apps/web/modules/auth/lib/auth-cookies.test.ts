import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `USE_SECURE_COOKIES` decides whether the session cookie carries `Secure`. Getting it wrong is the
 * ENG-2076 bug class: a deployment on HTTPS that serves the cookie without `Secure` lets a downgrade to
 * plaintext HTTP leak the session. It had no test before ENG-2599 rewrote its chain.
 */
const constantsMock = { AUTH_URL: undefined as string | undefined };
const envMock = { WEBAPP_URL: undefined as string | undefined };

vi.mock("@/lib/constants", () => constantsMock);
vi.mock("@/lib/env", () => ({ env: envMock }));

const load = async () => {
  vi.resetModules();
  return await import("./auth-cookies");
};

describe("USE_SECURE_COOKIES", () => {
  beforeEach(() => {
    constantsMock.AUTH_URL = undefined;
    envMock.WEBAPP_URL = undefined;
  });

  test("is true when the auth URL is https", async () => {
    constantsMock.AUTH_URL = "https://app.example.com";

    expect((await load()).USE_SECURE_COOKIES).toBe(true);
  });

  test("is false on http, so a local dev session can persist", async () => {
    constantsMock.AUTH_URL = "http://localhost:3000";

    expect((await load()).USE_SECURE_COOKIES).toBe(false);
  });

  test("falls back to WEBAPP_URL when no auth URL is configured (ENG-2076)", async () => {
    // The regression itself: a deployment that sets only WEBAPP_URL=https://… — the primary documented
    // variable — must still get `Secure`, not fall through to "" and serve the cookie without it.
    envMock.WEBAPP_URL = "https://app.example.com";

    expect((await load()).USE_SECURE_COOKIES).toBe(true);
  });

  test("prefers the auth URL over WEBAPP_URL", async () => {
    constantsMock.AUTH_URL = "http://auth.internal:3000";
    envMock.WEBAPP_URL = "https://app.example.com";

    expect((await load()).USE_SECURE_COOKIES).toBe(false);
  });

  test("is false when nothing is configured, rather than throwing", async () => {
    expect((await load()).USE_SECURE_COOKIES).toBe(false);
  });
});

describe("auth cookie names", () => {
  beforeEach(() => {
    constantsMock.AUTH_URL = undefined;
    envMock.WEBAPP_URL = undefined;
  });

  test("are __Host- prefixed on https, so a sibling subdomain cannot set them", async () => {
    constantsMock.AUTH_URL = "https://app.example.test";
    const cookies = await load();

    expect(cookies.AUTH_COOKIE_PREFIX).toBe("__Host-formbricks");
    expect(cookies.SESSION_TOKEN_COOKIE_NAME).toBe("__Host-formbricks.session_token");
    expect(cookies.AUTH_DEFAULT_COOKIE_ATTRIBUTES).toMatchObject({ secure: true, path: "/" });
    expect(cookies.AUTH_DEFAULT_COOKIE_ATTRIBUTES).not.toHaveProperty("domain");
  });

  test("are unprefixed on http, where a __Host- cookie could not be stored", async () => {
    constantsMock.AUTH_URL = "http://localhost:3000";
    const cookies = await load();

    expect(cookies.AUTH_COOKIE_PREFIX).toBe("formbricks");
    expect(cookies.SESSION_TOKEN_COOKIE_NAME).toBe("formbricks.session_token");
    expect(cookies.AUTH_DEFAULT_COOKIE_ATTRIBUTES).toMatchObject({ secure: false, path: "/" });
  });
});
