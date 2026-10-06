import { createDb } from "@hearloom/db";
import { env } from "./env";

export const { db, client: sql } = createDb(env.DATABASE_URL);
export { schema } from "@hearloom/db";
