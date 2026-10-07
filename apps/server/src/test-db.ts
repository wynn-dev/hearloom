/**
 * Test preload: database tests run against TEST_DATABASE_URL, or against DATABASE_URL only if it is
 * local. The .env (which worktree setup copies) may point at the real database, and tests insert and
 * delete rows and close every open conversation (closeOrphans), including a live one.
 */
const LOCAL = new Set(["", "localhost", "127.0.0.1", "[::1]"]);

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (url) {
  const host = new URL(url).hostname;
  if (!process.env.TEST_DATABASE_URL && !LOCAL.has(host)) {
    // Exit rather than throw: bun keeps running the test files after a failed preload.
    console.error(
      `Refusing to run tests against the database at ${host} (DATABASE_URL). Set TEST_DATABASE_URL to a throwaway database.`,
    );
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
}
