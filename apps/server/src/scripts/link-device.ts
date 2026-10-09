/**
 * Sign a device in without a password, from the server itself: for the first device, or when every
 * signed-in device is lost. Prints a single-use code (5 minutes) as a QR code for the iPhone app and
 * as a link for a browser.
 *   pnpm link-device --email you@example.com [--create [--name "You"] [--admin]] [--server <url>]
 * --create makes the account if there is none (the first account is always an admin).
 */
import { parseArgs } from "node:util";
import { toQR } from "toqr";
import { auth } from "../auth";
import { sql } from "../db";
import { env } from "../env";
import { CODE_TTL_MS, formatCode, linkUrls, mintLinkCode } from "../link/codes";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    email: { type: "string" },
    create: { type: "boolean", default: false },
    name: { type: "string" },
    admin: { type: "boolean", default: false },
    server: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!values.email) {
  fail(
    "usage: pnpm link-device --email <email> [--create [--name <name>] [--admin]] [--server <url>]",
  );
}

/** A QR code for a terminal: two modules per character (▀), dark on light with a quiet zone. */
function terminalQR(text: string): string {
  const modules = toQR(text);
  const size = Math.sqrt(modules.length);
  const quiet = 2;
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && modules[y * size + x] === 1;
  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = "";
    for (let x = -quiet; x < size + quiet; x++) {
      // Foreground paints the top module, background the bottom one (30/40 black, 97/107 white).
      line += `\x1b[${dark(x, y) ? 30 : 97};${dark(x, y + 1) ? 40 : 107}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

const ctx = await auth.$context;
const email = values.email.trim().toLowerCase();
let user = await ctx.internalAdapter.findUserByEmail(email).then((found) => found?.user ?? null);
if (!user) {
  if (!values.create) fail(`no account for ${email} (add --create to make one)`);
  const first = (await sql`select 1 from "user" limit 1`).length === 0;
  const admin = values.admin || first;
  user = await ctx.internalAdapter.createUser(
    {
      email,
      name: values.name ?? email.split("@")[0]!,
      emailVerified: true,
      role: admin ? "admin" : "user",
    },
    { method: "admin" },
  );
  console.log(`created ${admin ? "admin " : ""}account ${email}`);
}
if ((user as { banned?: boolean | null }).banned) fail(`${email} is banned`);

const server = (values.server ?? env.PUBLIC_URL).replace(/\/+$/, "");
if (!values.server && /\/\/(localhost|127\.|\[::1\])/.test(server)) {
  console.warn(
    `PUBLIC_URL is ${server}, which a phone can't reach: set it in .env, or pass --server https://<this-mac>.<tailnet>.ts.net`,
  );
}

const minted = await mintLinkCode(user.id, null);
const urls = linkUrls(server, minted.code);
const until = minted.expiresAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
console.log(`
Link a device to ${email} (one device, within ${CODE_TTL_MS / 60_000} minutes, until ${until})

iPhone: scan this with the Camera app, then open it in Hearloom.

${terminalQR(urls.appUrl)}

  or in the app: Link device → paste ${urls.appUrl}

Browser: open ${urls.webUrl}

Code: ${formatCode(minted.code)}   server: ${urls.server}
`);
await sql.end();
