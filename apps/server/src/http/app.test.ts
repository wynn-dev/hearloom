import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env";
import { app } from "./app";

const INDEX = '<!doctype html><div id="root"></div>';
const ASSET = "export const x = 1;";
let dist: string;
let webDist: string;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "hearloom-web-"));
  await Bun.write(join(dist, "index.html"), INDEX);
  await Bun.write(join(dist, "assets/index-abc123.js"), ASSET);
  webDist = env.WEB_DIST;
  env.WEB_DIST = dist;
});
afterAll(async () => {
  env.WEB_DIST = webDist;
  await rm(dist, { recursive: true, force: true });
});

const get = (path: string) => app.fetch(new Request(`http://127.0.0.1:3000${path}`));

test("the console's routes fall back to index.html", async () => {
  for (const path of ["/", "/timeline", "/agent?x=1", "/people/abc"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  }
});

test("built assets are served and cached for good", async () => {
  const res = await get("/assets/index-abc123.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("immutable");
  expect(await res.text()).toBe(ASSET);
});

test("missing assets and API paths are 404s, not the console's HTML", async () => {
  // A tab still on the previous build asks for chunks that are gone.
  for (const path of ["/assets/agent-OLDHASH.js", "/assets/index-OLD.css", "/api/nope", "/api/"]) {
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<div id="root">');
  }
});
