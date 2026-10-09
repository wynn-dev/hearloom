import { expect, test } from "bun:test";
import { parseLinkInput } from "./link";

test("parseLinkInput: the app's link, with the server it carries", () => {
  expect(
    parseLinkInput("hearloom://link?server=https%3A%2F%2Fmac.tail1234.ts.net&code=ABCD-0123-WXYZ"),
  ).toEqual({ server: "https://mac.tail1234.ts.net", code: "ABCD-0123-WXYZ" });
  // Unencoded, a trailing slash, surrounding whitespace.
  expect(
    parseLinkInput("  hearloom://link?server=http://macbook:3000/&code=ABCD0123WXYZ \n"),
  ).toEqual({ server: "http://macbook:3000", code: "ABCD0123WXYZ" });
});

test("parseLinkInput: a browser link, code after #", () => {
  expect(parseLinkInput("https://mac.tail1234.ts.net/link#code=ABCD-0123-WXYZ")).toEqual({
    server: "https://mac.tail1234.ts.net",
    code: "ABCD-0123-WXYZ",
  });
  // Served under a path prefix.
  expect(parseLinkInput("https://example.com/hearloom/link#code=ABCD-0123-WXYZ")).toEqual({
    server: "https://example.com/hearloom",
    code: "ABCD-0123-WXYZ",
  });
});

test("parseLinkInput: a bare code has no server", () => {
  expect(parseLinkInput("abcd-0123-wxyz")).toEqual({ server: null, code: "abcd-0123-wxyz" });
  expect(parseLinkInput("ABCD 0123 WXYZ")).toEqual({ server: null, code: "ABCD 0123 WXYZ" });
});

test("parseLinkInput: anything else is not a link", () => {
  for (const bad of [
    "",
    "ABCD-0123",
    "hello world!",
    "https://mac.tail1234.ts.net/",
    "https://mac.tail1234.ts.net/link",
    "hearloom://pair?code=ABCD-0123-WXYZ",
    "hearloom://link?code=ABCD-0123-WXYZ",
    "hearloom://link?server=javascript:alert(1)&code=ABCD-0123-WXYZ",
    "hearloom://link?server=file:///etc&code=ABCD-0123-WXYZ",
    "ftp://mac/link#code=ABCD-0123-WXYZ",
  ]) {
    expect(parseLinkInput(bad)).toBeNull();
  }
});
