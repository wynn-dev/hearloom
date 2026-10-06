import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index";

const { db, client } = createDb(undefined, { max: 1 });
await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
await client.end();
console.log("migrations applied");
