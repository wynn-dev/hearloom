import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { BunFile } from "bun";
import { env } from "./env";

/** Local-disk object storage under DATA_DIR/objects. Keys are slash-separated paths. */
export class LocalStorage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    if (clean.startsWith("/") || clean.includes("..")) throw new Error(`bad storage key ${key}`);
    return join(this.root, clean);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    await Bun.write(tmp, data);
    await rename(tmp, p);
  }

  file(key: string): BunFile {
    return Bun.file(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export const storage = new LocalStorage(join(env.DATA_DIR, "objects"));
