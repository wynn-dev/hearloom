import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

/**
 * Connection budget (hosted Postgres often allows ~25 direct connections): server 5 + its LISTEN
 * connection 1 + live pipeline 3 + worker 2 + pg-boss 2 in each of server and worker = 15 at most,
 * leaving room for migrations, psql and restarts.
 */
export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return { db, client };
}
