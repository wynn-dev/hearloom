import { expo } from "@better-auth/expo";
import { schema } from "@hearloom/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer } from "better-auth/plugins";
import { db } from "./db";
import { env } from "./env";

const extraOrigins = env.TRUSTED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export const auth = betterAuth({
  appName: "Hearloom",
  baseURL: env.PUBLIC_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  // Invite-only: accounts are created by an admin (console) or `pnpm create-user`.
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
  session: {
    // The phone stays signed in for months; sessions slide forward on use.
    expiresIn: 60 * 60 * 24 * 180,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins: [env.PUBLIC_URL, `${env.APP_SCHEME}://`, ...extraOrigins],
  plugins: [admin(), bearer(), expo()],
});

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** Resolve a session from cookies or an `Authorization: Bearer` header. */
export async function getSession(headers: Headers): Promise<AuthSession | null> {
  return auth.api.getSession({ headers });
}
