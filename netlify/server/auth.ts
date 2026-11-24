import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { loginAttempts } from "../../db/schema.js";

export const SESSION_COOKIE = "lelewal_admin";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 jours

const MAX_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

// Identifiant par défaut tant que ADMIN_USERNAME n'est pas configuré.
const DEFAULT_USERNAME = "admin";

export function adminUsername(): string {
  return (process.env.ADMIN_USERNAME || "").trim() || DEFAULT_USERNAME;
}

export function isAuthConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  // Hash first so both buffers have the same length and comparison is constant-time.
  return timingSafeEqual(sha256(a), sha256(b));
}

// The signing key is derived from SESSION_SECRET if present, otherwise from the
// admin password, so changing the password invalidates every existing session.
function signingKey(): Buffer {
  const base = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
  return createHmac("sha256", "lelewal-tv-admin-session-v1").update(base).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function checkCredentials(username: string, password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const userOk = safeEqual(username.trim().toLowerCase(), adminUsername().toLowerCase());
  const passOk = safeEqual(password, expected);
  return userOk && passOk;
}

export function createSessionToken(): string {
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `${Buffer.from(adminUsername()).toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token || !isAuthConfigured()) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [user, exp, signature] = parts;
  const payload = `${user}.${exp}`;
  const expectedSig = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const username = Buffer.from(user, "base64url").toString("utf8");
  if (username.toLowerCase() !== adminUsername().toLowerCase()) return null;
  return username;
}

// ---- Protection contre la force brute ----

export async function isLocked(ip: string): Promise<number> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, ip));
  if (!row) return 0;
  const elapsed = Date.now() - row.windowStart.getTime();
  if (elapsed > LOCK_WINDOW_MS) return 0;
  if (row.failures < MAX_FAILURES) return 0;
  return Math.ceil((LOCK_WINDOW_MS - elapsed) / 60000);
}

export async function recordFailure(ip: string): Promise<void> {
  const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.ip, ip));
  const now = new Date();
  if (!row) {
    await db.insert(loginAttempts).values({ ip, failures: 1, windowStart: now }).onConflictDoNothing();
    return;
  }
  if (now.getTime() - row.windowStart.getTime() > LOCK_WINDOW_MS) {
    await db.update(loginAttempts).set({ failures: 1, windowStart: now }).where(eq(loginAttempts.ip, ip));
  } else {
    await db
      .update(loginAttempts)
      .set({ failures: row.failures + 1 })
      .where(eq(loginAttempts.ip, ip));
  }
}

export async function clearFailures(ip: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.ip, ip));
}
