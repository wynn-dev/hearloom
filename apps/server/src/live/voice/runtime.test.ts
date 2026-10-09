import { expect, test } from "bun:test";
import type { Db } from "@hearloom/db";
import { VoiceRuntime } from "./runtime";
import type { VoiceConfig } from "./types";

function runtime(): VoiceRuntime {
  return new VoiceRuntime({
    db: null as unknown as Db,
    embedder: null,
    speakers: null,
    soniox: null,
    send: () => {},
    log: () => {},
  });
}

const adri: VoiceConfig = {
  mode: "on",
  wake: { names: ["Adri"], aliases: ["Andrew"], blocked: [] },
  minScore: 0.65,
  haptics: true,
};

test("terms wait for a config that isn't loaded yet (a session opened after a restart)", async () => {
  const rt = runtime();
  rt.config = () => Bun.sleep(50).then(() => adri);
  // Only the names bias the recognizer: an alias is what it mishears them as.
  expect(await rt.terms("u1")).toEqual(["Adri"]);
});

test("terms fall back to the last known ones when the config can't be loaded", async () => {
  const rt = runtime();
  rt.config = async () => adri;
  expect(await rt.terms("u1")).toEqual(["Adri"]);
  rt.config = () => Promise.reject(new Error("db down"));
  expect(await rt.terms("u1")).toEqual(["Adri"]);
  expect(await rt.terms("u2")).toEqual([]);
});
