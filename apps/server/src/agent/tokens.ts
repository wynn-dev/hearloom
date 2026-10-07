import { schema } from "@hearloom/db";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

/** New random token: `hl_` + 43 base64url chars (256 bits). */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `hl_${Buffer.from(bytes).toString("base64url")}`;
}

/** A full-access agent token: every MCP tool (reading, and editing episodes). */
export async function createToken(userId: string, name: string) {
  const token = generateToken();
  const [row] = await db
    .insert(schema.apiTokens)
    .values({ userId, name, prefix: token.slice(0, 10), tokenHash: hash(token) })
    .returning();
  return { token, row: row! };
}

/** Resolve `Authorization: Bearer hl_…` to its user (null: missing, unknown or revoked). */
export async function verifyToken(
  header: string | null,
): Promise<{ userId: string; id: string } | null> {
  // The auth scheme is case-insensitive (RFC 7235).
  const token = header?.match(/^bearer\s+(hl_[A-Za-z0-9_-]{20,})$/i)?.[1];
  if (!token) return null;
  const [row] = await db
    .select()
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.tokenHash, hash(token)), isNull(schema.apiTokens.revokedAt)));
  if (!row) return null;
  // Touch at most once a minute.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    // Drizzle only runs a query once it's awaited/then'd.
    db.update(schema.apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiTokens.id, row.id))
      .then(undefined, (err) => console.warn("[agent] token touch failed", err));
  }
  return { userId: row.userId, id: row.id };
}
