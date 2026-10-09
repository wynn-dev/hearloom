import { expect, test } from "bun:test";
import { codeFromHash, formatCountdown, linkCodeFor } from "./link";

const ORIGIN = "https://mac.tail1234.ts.net";

test("code from a /link page's hash", () => {
  expect(codeFromHash("#code=ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
  expect(codeFromHash("code=ABCD-EFGH-JKMN")).toBe("ABCD-EFGH-JKMN");
  expect(codeFromHash("#other=1&code=abcd")).toBe("abcd");
  expect(codeFromHash("")).toBeNull();
  expect(codeFromHash("#code=")).toBeNull();
  expect(codeFromHash("#nothing")).toBeNull();
});

test("a bare code, or a link for this server", () => {
  expect(linkCodeFor(" abcd-efgh-jkmn ", ORIGIN)).toEqual({ code: "abcd-efgh-jkmn" });
  expect(linkCodeFor(`${ORIGIN}/link#code=ABCD-EFGH-JKMN`, ORIGIN)).toEqual({
    code: "ABCD-EFGH-JKMN",
  });
  expect(linkCodeFor(`${ORIGIN}/link#code=ABCD-EFGH-JKMN`, `${ORIGIN}/`)).toEqual({
    code: "ABCD-EFGH-JKMN",
  });
  const app = `hearloom://link?server=${encodeURIComponent(ORIGIN)}&code=ABCD-EFGH-JKMN`;
  expect(linkCodeFor(app, ORIGIN)).toEqual({ code: "ABCD-EFGH-JKMN" });
});

test("refuses links for another server, and things that aren't codes", () => {
  const other = linkCodeFor("https://other.example/link#code=ABCD-EFGH-JKMN", ORIGIN);
  expect(other.code).toBeUndefined();
  expect(other.error).toContain("https://other.example");
  expect(linkCodeFor("http://mac.tail1234.ts.net/link#code=ABCD-EFGH-JKMN", ORIGIN).error).toBe(
    "That link is for http://mac.tail1234.ts.net, not this server. Open the link itself, or sign in there.",
  );
  expect(linkCodeFor("hunter2", ORIGIN).error).toBeDefined();
  expect(linkCodeFor("   ", ORIGIN).error).toBe("Paste a link or a code.");
});

test("countdown", () => {
  const now = 1_000_000;
  expect(formatCountdown(now + 300_000, now)).toBe("5:00");
  expect(formatCountdown(new Date(now + 300_900), now)).toBe("5:00");
  expect(formatCountdown(now + 299_999, now)).toBe("4:59");
  expect(formatCountdown(now + 9_000, now)).toBe("0:09");
  expect(formatCountdown(now - 5_000, now)).toBe("0:00");
});
