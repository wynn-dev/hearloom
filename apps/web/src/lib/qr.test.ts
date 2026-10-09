import { expect, test } from "bun:test";
import { toQR } from "toqr";
import { QUIET_ZONE, qrPath } from "./qr";

/** Paint a path made of `M x y h w v1 h-w z` rectangles back into modules. */
function paint(d: string, size: number): Uint8Array {
  const grid = new Uint8Array(size * size);
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, w, back] = [m[1], m[2], m[3], m[4]].map(Number) as [
      number,
      number,
      number,
      number,
    ];
    expect(back).toBe(w);
    for (let i = 0; i < w; i++) grid[y * size + x + i] = 1;
  }
  return grid;
}

test("runs of dark modules become one rectangle each, offset by the quiet zone", () => {
  // 3×3: row 0 = ##., row 1 = .#., row 2 = ###
  const modules = Uint8Array.from([1, 1, 0, 0, 1, 0, 1, 1, 1]);
  expect(qrPath(modules, 1)).toEqual({ size: 5, d: "M1 1h2v1h-2zM2 2h1v1h-1zM1 3h3v1h-3z" });
});

test("a real code round-trips, with a 4-module quiet zone left light", () => {
  const modules = toQR(
    "hearloom://link?server=https%3A%2F%2Fmac.tail1234.ts.net&code=ABCD-EFGH-JKMN",
  );
  const n = Math.sqrt(modules.length);
  const { size, d } = qrPath(modules);
  expect(size).toBe(n + 2 * QUIET_ZONE);
  // Only the path's grammar, nothing else.
  expect(d.replace(/M\d+ \d+h\d+v1h-\d+z/g, "")).toBe("");
  const grid = paint(d, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= QUIET_ZONE && y >= QUIET_ZONE && x < n + QUIET_ZONE && y < n + QUIET_ZONE;
      const expected = inside ? modules[(y - QUIET_ZONE) * n + (x - QUIET_ZONE)] : 0;
      expect(grid[y * size + x]).toBe(expected);
    }
  }
});

test("rejects a non-square module list", () => {
  expect(() => qrPath(new Uint8Array(5))).toThrow();
});
