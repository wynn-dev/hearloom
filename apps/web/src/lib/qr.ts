/** QR codes as SVG: `toqr` encodes, this draws. */

/** Light modules around the code that scanners need to find it (the QR spec asks for 4). */
export const QUIET_ZONE = 4;

/**
 * An SVG path of a QR code's dark modules (`toQR`'s output: size × size, row-major, 1 = dark),
 * offset by a quiet zone. Each horizontal run of dark modules is one rectangle, which keeps the path
 * short and leaves no hairline seams between neighbors. `size` is the full width in modules, quiet
 * zone included: use it for the viewBox.
 */
export function qrPath(modules: Uint8Array, quiet = QUIET_ZONE): { size: number; d: string } {
  const n = Math.sqrt(modules.length);
  if (!Number.isInteger(n)) throw new Error("QR modules must form a square");
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (modules[y * n + x] !== 1) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && modules[y * n + x] === 1) x++;
      const run = x - start;
      parts.push(`M${start + quiet} ${y + quiet}h${run}v1h-${run}z`);
    }
  }
  return { size: n + 2 * quiet, d: parts.join("") };
}
