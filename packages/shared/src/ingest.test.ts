import { expect, test } from "bun:test";
import { parseClientMessage } from "./ingest";

const phoneId = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
const id = "01a1221c-d1b7-764f-badb-110f91f431a1";
const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));

test("presence and hello: features are optional; a malformed list counts as none", () => {
  expect(parse({ t: "presence", v: 1, phoneId })).toEqual({ t: "presence", v: 1, phoneId });
  expect(parse({ t: "presence", v: 1, phoneId, features: ["haptic_seq"] })).toMatchObject({
    features: ["haptic_seq"],
  });
  for (const features of [
    Array.from({ length: 17 }, (_, i) => `f${i}`),
    ["x".repeat(33)],
    "haptic_seq",
    [1],
  ]) {
    const m = parse({ t: "presence", v: 1, phoneId, features });
    expect(m).toMatchObject({ t: "presence", phoneId });
    expect((m as { features?: unknown }).features).toBeUndefined();
  }
  const stream = { id, codec: 20, sampleRate: 16000, frameMs: 20, startedAt: 1_760_000_000_000 };
  expect(
    parse({ t: "hello", v: 1, slot: 0, phoneId, stream, features: ["haptic_seq"] }),
  ).toMatchObject({ t: "hello", features: ["haptic_seq"] });
});

test("haptic_ack", () => {
  expect(parse({ t: "haptic_ack", id, played: true })).toEqual({
    t: "haptic_ack",
    id,
    played: true,
  });
  expect(parse({ t: "haptic_ack", id, played: false, reason: "no_pendant" })).toMatchObject({
    reason: "no_pendant",
  });
  expect(parse({ t: "haptic_ack", id, played: false, reason: "expired" })).toMatchObject({
    reason: "expired",
  });
  // A reason from a newer build: still an ack.
  expect(parse({ t: "haptic_ack", id, played: false, reason: "busy" })).toEqual({
    t: "haptic_ack",
    id,
    played: false,
  });
  expect(() => parse({ t: "haptic_ack", id: "nope", played: true })).toThrow();
  expect(() => parse({ t: "haptic_ack", id })).toThrow();
});

test("unknown message types are ignored (null); known ones with bad fields throw", () => {
  expect(parse({ t: "something_new", x: 1 })).toBeNull();
  expect(() => parse({ t: "ping" })).toThrow();
  expect(() => parse({ nope: true })).toThrow();
  expect(() => parseClientMessage("not json")).toThrow();
});
