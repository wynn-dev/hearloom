import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { BunFile } from "bun";
import { env } from "./env";
import { fsyncDir } from "./ingest/stream-writer";

/** Local-disk object storage under DATA_DIR/objects. Keys are slash-separated paths. */
export class LocalStorage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    if (clean.startsWith("/") || clean.includes("..")) throw new Error(`bad storage key ${key}`);
    return join(this.root, clean);
  }

  /** Durable write: the file and its directory entry are fsynced before this resolves. */
  async put(key: string, data: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    const fh = await open(tmp, "w");
    try {
      await fh.write(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, p);
    await fsyncDir(dirname(p));
  }

  file(key: string): BunFile {
    return Bun.file(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export const storage = new LocalStorage(join(env.DATA_DIR, "objects"));
