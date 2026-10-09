/**
 * "Link device" codes: single-use, short-lived codes that sign a device in as one user, in place of a
 * password. Minted by a signed-in console (Devices, or an admin on Users) or `pnpm link-device` on the
 * server; redeemed at /api/auth/link/redeem (auth.ts), usually by scanning a QR code.
 */
import { createHash, getRandomValues } from "node:crypto";
import { schema } from "@hearloom/db";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

const { linkCodes } = schema;

/** Crockford base32: no I, L, O or U, so nothing reads as another symbol. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 12 symbols of 5 bits: 60 bits, far beyond guessing in the few minutes a code lives. */
export const CODE_LENGTH = 12;
export const CODE_TTL_MS = 5 * 60_000;

export function generateCode(): string {
  // 256 is a multiple of 32, so masking the low 5 bits keeps every symbol equally likely.
  return Array.from(getRandomValues(new Uint8Array(CODE_LENGTH)), (b) => ALPHABET[b & 31]).join("");
}

/**
 * A code as typed or pasted (any case, with spaces or dashes, O for 0, I or L for 1) in canonical
 * form, or null if it can't be one.
 */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!ALPHABET.includes(c)) return null;
  return code;
}

/** XXXX-XXXX-XXXX, for reading aloud or typing. */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)!.join("-");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Where a device goes with a code. `server` is how the device reaches this server: the address the
 * console that minted the code is on, or PUBLIC_URL. The web link keeps the code after `#`, so it never
 * reaches the server's (or a proxy's) logs.
 */
export function linkUrls(server: string, code: string) {
  const base = server.replace(/\/+$/, "");
  const app = new URL(`${env.APP_SCHEME}://link`);
  app.searchParams.set("server", base);
  app.searchParams.set("code", formatCode(code));
  return { server: base, appUrl: app.toString(), webUrl: `${base}/link#code=${formatCode(code)}` };
}

export interface MintedCode {
  id: string;
  code: string;
  expiresAt: Date;
}

/** A new code that signs a device in as `userId`. `createdBy` is null when minted from the CLI. */
export async function mintLinkCode(userId: string, createdBy: string | null): Promise<MintedCode> {
  const now = new Date();
  // Housekeeping: codes are only worth keeping a day (the console shows recent ones as "used").
  await db.delete(linkCodes).where(lt(linkCodes.expiresAt, new Date(now.getTime() - 86_400_000)));
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const [row] = await db
    .insert(linkCodes)
    .values({ userId, createdBy, codeHash: sha256Hex(code), expiresAt })
    .returning({ id: linkCodes.id });
  return { id: row!.id, code, expiresAt };
}

/**
 * Use up a code: the user it signs in as, or null if it is unknown, used or expired. Atomic, so two
 * devices racing with one code can't both get in.
 */
export async function consumeLinkCode(
  input: string,
): Promise<{ id: string; userId: string } | null> {
  const code = normalizeCode(input);
  if (!code) return null;
  const now = new Date();
  const [row] = await db
    .update(linkCodes)
    .set({ redeemedAt: now })
    .where(
      and(
        eq(linkCodes.codeHash, sha256Hex(code)),
        isNull(linkCodes.redeemedAt),
        gt(linkCodes.expiresAt, now),
      ),
    )
    .returning({ id: linkCodes.id, userId: linkCodes.userId });
  return row ?? null;
}

/** Record which session a redeemed code became (shown as "linked" in the console). */
export async function attachLinkSession(codeId: string, sessionId: string): Promise<void> {
  await db.update(linkCodes).set({ sessionId }).where(eq(linkCodes.id, codeId));
}

/** A code's state, for the console that minted it (by its minter, or for the user it signs in). */
export async function linkCodeStatus(id: string, viewer: string) {
  const [row] = await db
    .select()
    .from(linkCodes)
    .where(
      and(eq(linkCodes.id, id), or(eq(linkCodes.createdBy, viewer), eq(linkCodes.userId, viewer))),
    );
  if (!row) return null;
  return {
    status: row.redeemedAt
      ? ("redeemed" as const)
      : row.expiresAt <= new Date()
        ? ("expired" as const)
        : ("pending" as const),
    sessionId: row.sessionId,
  };
}
