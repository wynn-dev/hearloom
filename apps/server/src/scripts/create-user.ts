/**
 * Bootstrap or add an account (sign-up is disabled; Hearloom is invite-only).
 *   pnpm --filter @hearloom/server create-user -- --email you@example.com --name "You" [--admin]
 * The password is read from HEARLOOM_PASSWORD or prompted.
 */
import { parseArgs } from "node:util";
import { auth } from "../auth";
import { sql } from "../db";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    email: { type: "string" },
    name: { type: "string" },
    admin: { type: "boolean", default: false },
  },
});

if (!values.email) {
  console.error("usage: create-user --email <email> [--name <name>] [--admin]");
  process.exit(1);
}

const password = process.env.HEARLOOM_PASSWORD ?? prompt("Password (min 10 chars):") ?? "";
if (password.length < 10) {
  console.error("password must be at least 10 characters");
  process.exit(1);
}

const ctx = await auth.$context;
const email = values.email.toLowerCase();
if (await ctx.internalAdapter.findUserByEmail(email)) {
  console.error(`a user with email ${email} already exists`);
  process.exit(1);
}
const user = await ctx.internalAdapter.createUser(
  {
    email,
    name: values.name ?? email.split("@")[0]!,
    emailVerified: true,
    role: values.admin ? "admin" : "user",
  },
  { method: "admin" },
);
await ctx.internalAdapter.linkAccount({
  userId: user.id,
  providerId: "credential",
  accountId: user.id,
  password: await ctx.password.hash(password),
});
console.log(`created ${values.admin ? "admin " : ""}user ${email} (${user.id})`);
await sql.end();
