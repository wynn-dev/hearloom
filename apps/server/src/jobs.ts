import { PgBoss } from "pg-boss";
import { env } from "./env";

export const QUEUES = {
  refine: "refine-block",
  /** Jobs queued before blocks existed; each conversation became a block with the same id. */
  refineLegacy: "refine-conversation",
} as const;

export interface RefineJob {
  blockId: string;
}

export interface LegacyRefineJob {
  conversationId: string;
}

let boss: PgBoss | null = null;

/** Shared pg-boss instance (job queue in Postgres). The server only sends; the worker consumes. */
export async function jobs(): Promise<PgBoss> {
  if (!boss) {
    // Small pool: one job at a time, and the connection budget is shared (see createDb).
    const b = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss", max: 2 });
    b.on("error", (err) => console.error("[jobs]", err));
    await b.start();
    // Per block, at most one job waiting and one running: audio that arrives while a block is
    // being refined still gets its own pass.
    await b.createQueue(QUEUES.refine, { policy: "stately" });
    await b.createQueue(QUEUES.refineLegacy);
    boss = b;
  }
  return boss;
}

/** Queue a refine pass for a finished block (no-op if one is already waiting for it). */
export async function enqueueRefine(blockId: string): Promise<void> {
  const b = await jobs();
  await b.send(QUEUES.refine, { blockId } satisfies RefineJob, {
    singletonKey: blockId,
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
