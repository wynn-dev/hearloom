/**
 * Picks the database for tests: TEST_DATABASE_URL, or DATABASE_URL only if it is on this machine.
 * The .env (which worktree setup copies, and bun loads by itself from the current directory) may
 * point at the real database, and tests insert and delete rows and close every open conversation
 * (closeOrphans), including a live one. Otherwise it exits before any test touches a database.
 *
 * Runs as the bun test preload (apps/server/bunfig.toml) and, because bun only reads bunfig.toml
 * from the current directory, also as the first import of every test file that uses a database.
 */
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

function refuse(why: string): never {
  console.error(
    `Refusing to run database tests: ${why}. Set TEST_DATABASE_URL to a throwaway database.`,
  );
  // Exit rather than throw: some bun versions keep running test files after a failed preload.
  process.exit(1);
}

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (url) {
  if (!process.env.TEST_DATABASE_URL) {
    let host: string;
    try {
      // postgres.js falls back to PGHOST for an empty host.
      host = new URL(url).hostname || process.env.PGHOST || "localhost";
    } catch {
      refuse("DATABASE_URL is not a URL this check understands");
    }
    if (!LOCAL.has(host)) refuse(`DATABASE_URL points at ${host}`);
  }
  process.env.DATABASE_URL = url;
}
