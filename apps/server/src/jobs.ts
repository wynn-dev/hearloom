import { PgBoss } from "pg-boss";
import { env } from "./env";

export const QUEUES = {
  refine: "refine-conversation",
} as const;

export interface RefineJob {
  conversationId: string;
}

let boss: PgBoss | null = null;

/** Shared pg-boss instance (job queue in Postgres). The server only sends; the worker consumes. */
export async function jobs(): Promise<PgBoss> {
  if (!boss) {
    const b = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss" });
    b.on("error", (err) => console.error("[jobs]", err));
    await b.start();
    for (const name of Object.values(QUEUES)) await b.createQueue(name);
    boss = b;
  }
  return boss;
}

/** Queue a refine pass for a finished conversation (deduplicated per conversation). */
export async function enqueueRefine(conversationId: string): Promise<void> {
  const b = await jobs();
  await b.send(QUEUES.refine, { conversationId } satisfies RefineJob, {
    singletonKey: conversationId,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 3600,
  });
}

export async function stopJobs(): Promise<void> {
  await boss?.stop({ graceful: true, timeout: 10_000 });
  boss = null;
}
