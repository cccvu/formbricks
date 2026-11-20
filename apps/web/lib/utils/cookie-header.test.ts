import { describe, expect, test } from "vitest";
import { getValidCookiePairs, stripInvalidCookiePairs, trimCookiePair } from "./cookie-header";

const HOST_COOKIE = "__Host-formbricks.session_token";

const strip = (cookie: string): string | null => {
  const headers = new Headers({ cookie });
  stripInvalidCookiePairs(headers);
  return headers.get("cookie");
};

describe("trimCookiePair", () => {
  test("trims spaces and tabs only", () => {
    expect(trimCookiePair(" \ta=1\t ")).toBe("a=1");
    expect(trimCookiePair(`\u00A0${HOST_COOKIE}=x`)).toBe(`\u00A0${HOST_COOKIE}=x`);
  });
});

describe("getValidCookiePairs", () => {
  test("returns token-named pairs in order", () => {
    expect(getValidCookiePairs(`a=1; ${HOST_COOKIE}=v.s; b=`)).toEqual(["a=1", `${HOST_COOKIE}=v.s`, "b="]);
  });

  test.each([
    ["a leading U+00A0 (0xA0 byte)", `\u00A0${HOST_COOKIE}=planted`],
    ["another Unicode space", `\u2003${HOST_COOKIE}=planted`],
    ["a space inside the name", "bad name=1"],
    ["a control character", "bad\u0001=1"],
    ["a separator character", "bad(name)=1"],
    ["an empty name", "=1"],
    ["no '=' at all", "nameless"],
  ])("drops a pair whose name has %s", (_label, pair) => {
    expect(getValidCookiePairs(`a=1; ${pair}; b=2`)).toEqual(["a=1", "b=2"]);
  });
});

describe("stripInvalidCookiePairs", () => {
  test("drops a planted U+00A0-led __Host- cookie and keeps the real one", () => {
    expect(strip(`\u00A0${HOST_COOKIE}=planted; ${HOST_COOKIE}=real; other=1`)).toBe(
      `${HOST_COOKIE}=real; other=1`
    );
  });

  test("leaves a valid header byte for byte, empty pairs and odd spacing included", () => {
    const header = `a=1;b=2;  ${HOST_COOKIE}=x;;`;
    expect(strip(header)).toBe(header);
  });

  test("deletes the header when no valid pair is left", () => {
    expect(strip(`\u00A0${HOST_COOKIE}=planted`)).toBeNull();
  });

  test("does nothing without a Cookie header", () => {
    const headers = new Headers();
    stripInvalidCookiePairs(headers);
    expect(headers.has("cookie")).toBe(false);
  });
});
