import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, schema } from "@hearloom/db";
import { SPEAKER_MODEL_ID } from "@hearloom/inference";
import { and, asc, eq, isNull } from "drizzle-orm";
import { renderLines } from "../mcp/render";
import type { DiarSegment } from "./diarizer";
import {
  assignKeys,
  type ClusterFacts,
  consolidate,
  finishChain,
  mergeLines,
  type RefineDeps,
  refineBlock,
  windows,
} from "./refine";

test("long blocks are refined in windows", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 6, 0, 0) + h * 3600_000);
  const rows = [0, 1, 2.5, 3.5, 4, 7.2].map((h) => ({ startAt: at(h), endAt: at(h + 0.1) }));
  expect(windows(rows, 3 * 3600_000).map((w) => w.length)).toEqual([3, 2, 1]);
});

describe("mergeLines", () => {
  const line = (
    startAt: number,
    endAt: number,
    text: string,
    speaker: string | null,
    lang = "en",
  ) => ({
    startAt,
    endAt,
    text,
    lang,
    speaker,
    confidence: 0.9,
    model: "rt",
  });

  test("joins one speaker's fragments, not other speakers' or across long pauses", () => {
    const out = mergeLines([
      line(0, 2000, "Um,", "a"),
      line(2500, 4000, "so.", "a"),
      line(4200, 5000, "Recursion.", "a"),
      line(5500, 6000, "Yes.", "b"),
      line(6200, 7000, "Right.", "a"),
      line(9000, 10_000, "Later.", "a"), // 2 s pause
    ]);
    expect(out.map((l) => [l.text, l.speaker, l.startAt, l.endAt])).toEqual([
      ["Um, so. Recursion.", "a", 0, 5000],
      ["Yes.", "b", 5500, 6000],
      ["Right.", "a", 6200, 7000],
      ["Later.", "a", 9000, 10_000],
    ]);
  });

  test("short lines without a speaker join a neighbor; longer ones and other languages stay", () => {
    const out = mergeLines([
      line(0, 300, "Um,", null),
      line(500, 3000, "well, the options.", "a"),
      line(3500, 3700, "Yes.", null),
      line(4000, 6000, "It did.", null), // no speaker, not short: may be someone else
      line(6500, 7000, "You're right.", null),
      line(7500, 9000, "Ja, dat klopt.", "a", "nl"),
      line(9500, 11_000, "Okay.", "a"),
    ]);
    expect(out.map((l) => l.text)).toEqual([
      "Um, well, the options. Yes.",
      "It did.",
      "You're right.",
      "Ja, dat klopt.",
      "Okay.",
    ]);
    expect(out[0]!.speaker).toBe("a");
  });

  test("stops at the length cap and keeps a text-weighted confidence", () => {
    const words = Array.from({ length: 40 }, (_, i) => line(i * 1000, i * 1000 + 900, "w", "a"));
    const out = mergeLines(words);
    expect(out.every((l) => l.endAt - l.startAt <= 30_000)).toBe(true);
    expect(out).toHaveLength(2);
    const [m] = mergeLines([
      { ...line(0, 1000, "aaa", "a"), confidence: 1 },
      { ...line(1000, 2000, "b", "a"), confidence: 0 },
    ]);
    expect(m!.confidence).toBeCloseTo(0.75);
  });
});

test("timeline lines are ordered by time across days, with day headers", () => {
  const tz = "Europe/Amsterdam";
  const mon = new Date("2026-10-05T07:00:00Z");
  const tue = new Date("2026-10-06T07:00:00Z");
  const utt = (id: string, startAt: Date, text: string) => ({
    id,
    startAt,
    speaker: "Me",
    text,
    lang: "en",
  });
  const lines = renderLines([utt("b", tue, "tuesday"), utt("a", mon, "monday")], [], tz, {
    bookmarks: [{ at: new Date("2026-10-05T08:00:00Z"), note: "idea" }],
    dayHeaders: true,
  });
  expect(lines).toEqual([
    "## Mon 2026-10-05",
    "09:00:00 Me: monday",
    "10:00:00 ⚑ bookmark: idea",
    "## Tue 2026-10-06",
    "09:00:00 Me: tuesday",
  ]);
});

/** One-hot voices: index 0, 1, 2… */
const voice = (i: number) => Float32Array.from({ length: 3 }, (_, j) => (j === i ? 1 : 0));

describe("assignKeys", () => {
  const facts = (label: string, f: Partial<ClusterFacts>): ClusterFacts => ({
    label,
    anchors: new Map(),
    embedding: null,
    liveKeys: new Map(),
    ...f,
  });
  const known = [
    { key: "S1", centroid: voice(0), personId: "alice", isSelf: false },
    { key: "S2", centroid: voice(1), personId: null, isSelf: null },
  ];

  test("shared speech with the previous block wins, then a known voice", () => {
    const keys = assignKeys(
      [
        facts("a", { anchors: new Map([["S2", 8000]]), embedding: voice(0) }),
        facts("b", { embedding: voice(0) }),
      ],
      known,
      ["S1", "S2"],
      0.6,
    );
    expect(keys.get("a")).toMatchObject({ key: "S2", source: "anchor" });
    expect(keys.get("b")).toMatchObject({ key: "S1", source: "voice" });
    expect(keys.get("b")!.known!.personId).toBe("alice");
  });

  test("one key per cluster: the cluster sharing the most speech takes it", () => {
    const keys = assignKeys(
      [
        facts("talker", { anchors: new Map([["S1", 2500]]) }),
        facts("alice", { anchors: new Map([["S1", 9000]]) }),
      ],
      known,
      ["S1", "S2"],
      0.6,
    );
    expect(keys.get("alice")!.key).toBe("S1");
    expect(keys.get("talker")).toMatchObject({ key: "S3", source: "new" });
  });

  test("too little shared speech doesn't anchor", () => {
    const keys = assignKeys(
      [facts("a", { anchors: new Map([["S2", 1500]]) })],
      known,
      ["S1", "S2"],
      0.6,
    );
    expect(keys.get("a")!.source).toBe("new");
  });

  test("new voices keep their live key unless it is a known voice's, else get the next key", () => {
    const keys = assignKeys(
      [
        facts("a", { embedding: voice(2), liveKeys: new Map([["S7", 4]]) }),
        facts("b", { liveKeys: new Map([["S7", 1]]) }),
        facts("c", { liveKeys: new Map([["S1", 3]]) }),
      ],
      known,
      ["S1", "S2", "S7", "S9"],
      0.6,
    );
    expect(keys.get("a")).toMatchObject({ key: "S7", source: "live" });
    expect(keys.get("b")).toMatchObject({ key: "S10", source: "new" });
    expect(keys.get("c")).toMatchObject({ key: "S11", source: "new" });
  });
});

describe("consolidate", () => {
  const sp = (
    blockId: string,
    key: string,
    v: number,
    seconds = 10,
    personId: string | null = null,
  ) => ({
    blockId,
    key,
    personId,
    isSelf: null,
    centroid: Array.from(voice(v)),
    seconds,
  });

  test("merges keys of the same voice from different blocks into the longest one", () => {
    const renames = consolidate(
      [sp("b1", "S1", 0, 30), sp("b1", "S2", 1), sp("b2", "S5", 0, 5), sp("b2", "S2", 1)],
      0.6,
    );
    expect([...renames]).toEqual([["S5", "S1"]]);
  });

  test("keeps keys apart when they speak in the same block or are different people", () => {
    expect(consolidate([sp("b1", "S1", 0), sp("b1", "S2", 0)], 0.6).size).toBe(0);
    // S2 has no stored voice in b1, but its lines show it spoke there too.
    const heardIn = new Map([["S2", new Set(["b1", "b2"])]]);
    expect(consolidate([sp("b1", "S1", 0), sp("b2", "S2", 0)], 0.6, heardIn).size).toBe(0);
    expect(
      consolidate([sp("b1", "S1", 0, 10, "alice"), sp("b2", "S3", 0, 10, "bob")], 0.6).size,
    ).toBe(0);
  });
});

describe("refining the blocks of a chain", () => {
  const { db, client } = createDb(process.env.DATABASE_URL, { max: 2 });
  const userId = `test-${crypto.randomUUID()}`;
  const streamId = crypto.randomUUID();
  const t0 = Date.UTC(2026, 9, 1, 9, 0);
  const MIN = 60_000;
  let aliceId = "";

  /** Who speaks when (absolute ms): amplitude 0.1 × (voice + 1) in the fake audio. */
  const speech: { from: number; to: number; voice: number; block: "A" | "B"; live: string }[] = [
    { from: t0, to: t0 + 5_000, voice: 0, block: "A", live: "S1" },
    { from: t0 + 6_000, to: t0 + 11_000, voice: 1, block: "A", live: "S2" },
    { from: t0 + 9 * MIN, to: t0 + 9 * MIN + 20_000, voice: 0, block: "A", live: "S1" },
    { from: t0 + 10 * MIN - 30_000, to: t0 + 10 * MIN - 10_000, voice: 1, block: "A", live: "S2" },
    // Block B: the live keys drifted (the live pass is less consistent than refine).
    { from: t0 + 10 * MIN, to: t0 + 10 * MIN + 8_000, voice: 1, block: "B", live: "S5" },
    { from: t0 + 11 * MIN, to: t0 + 11 * MIN + 8_000, voice: 0, block: "B", live: "S6" },
    { from: t0 + 12 * MIN, to: t0 + 12 * MIN + 8_000, voice: 2, block: "B", live: "S7" },
  ];
  const ampAt = (ms: number) => {
    const s = speech.find((x) => ms >= x.from && ms < x.to);
    return s ? 0.1 * (s.voice + 1) : 0;
  };

  /** Labels clusters in order of appearance, so they differ from block to block. */
  const diarizer = {
    async diarize(samples: Float32Array): Promise<DiarSegment[]> {
      const labels = new Map<number, string>();
      const segs: DiarSegment[] = [];
      let cur: { v: number; start: number; end: number } | null = null;
      const flush = () => {
        if (!cur || cur.v === 0) return;
        if (!labels.has(cur.v)) labels.set(cur.v, `spk${labels.size}`);
        segs.push({ speaker: labels.get(cur.v)!, start: cur.start, end: cur.end });
      };
      for (let i = 0; i < samples.length; i += 1600) {
        const v = Math.round(samples[i]! * 10);
        const t = i / 16000;
        if (cur && cur.v === v) cur.end = t + 0.1;
        else {
          flush();
          cur = { v, start: t, end: t + 0.1 };
        }
      }
      flush();
      return segs;
    },
  };
  const embedder = {
    embed(audio: Float32Array) {
      let sum = 0;
      for (const x of audio) sum += Math.abs(x);
      return voice(Math.round((sum / audio.length) * 10) - 1);
    },
  };
  const deps = (): RefineDeps => ({
    db,
    embedder,
    diarizer,
    matchThreshold: 0.6,
    clusterThreshold: 0.6,
    loadPieces: async (_stream, from, to) => {
      const samples = new Float32Array(Math.round((to - from) * 16));
      for (let i = 0; i < samples.length; i++) samples[i] = ampAt(from + i / 16);
      return [{ startAt: from, samples }];
    },
    log: () => {},
  });

  beforeAll(async () => {
    await db.insert(schema.user).values({ id: userId, name: "t", email: `${userId}@test.local` });
    const [alice] = await db
      .insert(schema.people)
      .values({ userId, name: "Alice" })
      .returning({ id: schema.people.id });
    aliceId = alice!.id;
    await db.insert(schema.voiceprints).values({
      userId,
      personId: aliceId,
      model: SPEAKER_MODEL_ID,
      embedding: Array.from(voice(0)),
      sampleSeconds: 10,
      source: "enrollment",
    });
    await db.insert(schema.captureStreams).values({
      id: streamId,
      userId,
      codec: 21,
      sampleRate: 16000,
      frameMs: 20,
      startedAt: new Date(t0),
    });
  });
  afterAll(async () => {
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await client.end();
  });

  /** A finished conversation of two closed blocks with live rows (see `speech`). */
  async function chain() {
    const [conv] = await db
      .insert(schema.conversations)
      .values({
        userId,
        startedAt: new Date(t0),
        endedAt: new Date(t0 + 12 * MIN + 8_000),
        status: "closed",
      })
      .returning({ id: schema.conversations.id });
    const chainId = conv!.id;
    const block = async (from: number, to: number) =>
      (
        await db
          .insert(schema.blocks)
          .values({
            userId,
            chainId,
            startedAt: new Date(from),
            endedAt: new Date(to),
            status: "closed",
          })
          .returning({ id: schema.blocks.id })
      )[0]!.id;
    const blockA = await block(t0, t0 + 10 * MIN - 10_000);
    const blockB = await block(t0 + 10 * MIN, t0 + 12 * MIN + 8_000);
    await db.insert(schema.utterances).values(
      speech.map((s, i) => ({
        userId,
        conversationId: chainId,
        blockId: s.block === "A" ? blockA : blockB,
        streamId,
        startAt: new Date(s.from),
        endAt: new Date(s.to),
        speakerKey: s.live,
        text: `line ${i}`,
        source: "live" as const,
        provider: "test",
      })),
    );
    return { chainId, blockA, blockB };
  }

  const current = (blockId: string) =>
    db
      .select()
      .from(schema.utterances)
      .where(and(eq(schema.utterances.blockId, blockId), isNull(schema.utterances.supersededAt)))
      .orderBy(asc(schema.utterances.startAt));

  test("speaker keys carry over from block to block, and the chain finishes", async () => {
    const { chainId, blockA, blockB } = await chain();
    const a = await refineBlock(deps(), blockA);
    expect(a).toMatchObject({ chainId, refined: true, replaced: 4 });
    // Not finished: block B is still to refine.
    expect((await finishChain(deps(), chainId)).finished).toBe(false);
    const rowsA = await current(blockA);
    expect(rowsA.map((u) => u.speakerKey)).toEqual(["S1", "S2", "S1", "S2"]);
    expect(rowsA.map((u) => u.personId)).toEqual([aliceId, null, aliceId, null]);
    expect(rowsA.every((u) => u.source === "refine")).toBe(true);

    const b = await refineBlock(deps(), blockB);
    expect(b).toMatchObject({ refined: true, replaced: 3 });
    const rowsB = await current(blockB);
    // Voice 1 continues from the context (S2), voice 0 is the known Alice (S1), voice 2 is new
    // and keeps its live key.
    expect(rowsB.map((u) => u.speakerKey)).toEqual(["S2", "S1", "S7"]);
    expect(rowsB[1]!.personId).toBe(aliceId);
    const [stored] = await db.select().from(schema.blocks).where(eq(schema.blocks.id, blockB));
    expect(stored!.status).toBe("refined");
    expect(stored!.speakers.map((s) => s.key).sort()).toEqual(["S1", "S2", "S7"]);

    const done = await finishChain(deps(), chainId);
    expect(done.finished).toBe(true);
    const [conv] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, chainId));
    expect(conv!.status).toBe("refined");
    expect(conv!.speakerCount).toBe(3);

    expect((await refineBlock(deps(), blockB)).message).toBe("already refined");
  });

  test("speech added while a block is refined leaves it for another pass", async () => {
    const { blockA } = await chain();
    const r = await refineBlock(
      {
        ...deps(),
        loadPieces: async (stream, from, to) => {
          // Backlog lands in the block meanwhile (see BlockTracker.backlog).
          await db
            .update(schema.blocks)
            .set({ status: "closed" })
            .where(eq(schema.blocks.id, blockA));
          return deps().loadPieces!(stream, from, to);
        },
      },
      blockA,
    );
    expect(r).toMatchObject({ refined: false, replaced: 4 });
    const [row] = await db.select().from(schema.blocks).where(eq(schema.blocks.id, blockA));
    expect(row!.status).toBe("closed");
    // The next pass refines it (the rows refined meanwhile stay as they are).
    expect(await refineBlock(deps(), blockA)).toMatchObject({ refined: true, replaced: 4 });
  });

  test("a block the diarizer finds no speech in keeps its live rows and is refined", async () => {
    const { blockA } = await chain();
    const r = await refineBlock({ ...deps(), diarizer: { diarize: async () => [] } }, blockA);
    expect(r).toMatchObject({ refined: true, replaced: 0 });
    const rows = await current(blockA);
    expect(rows.map((u) => [u.source, u.speakerKey])).toEqual([
      ["live", "S1"],
      ["live", "S2"],
      ["live", "S1"],
      ["live", "S2"],
    ]);
  });

  test("without voice embeddings, the shared context alone carries keys and names over", async () => {
    const { blockA, blockB } = await chain();
    await refineBlock(deps(), blockA);
    await refineBlock({ ...deps(), embedder: null }, blockB);
    const rowsB = await current(blockB);
    expect(rowsB.map((u) => u.speakerKey)).toEqual(["S2", "S1", "S7"]);
    // Alice was named in block A; her key carries the name into block B.
    expect(rowsB.map((u) => u.personId)).toEqual([null, aliceId, null]);
  });
});
