/**
 * Session + bearer-token guards.
 *
 * Pattern matches /home/bmasia/bmasia-audio-sharing/src/lib/auth.ts —
 * iron-session for UI users, AGENT_API_TOKEN bearer for cron/agent calls.
 *
 * Email allowlist via ALLOWED_EMAILS env var is layered on top so that even
 * with a valid password, only BMAsia team emails can sign in.
 */

import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";

export interface SessionData {
  userId: number;
  email: string;
  role: string;
  isLoggedIn: boolean;
}

const sessionOptions = {
  password:
    process.env.SESSION_SECRET ||
    "dev_only_session_secret_32_characters_min_change_me_please",
  cookieName: "bmasia-syb-monitor-session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 7, // 1 week
  },
};

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

export class UnauthorizedError extends Error {
  constructor(msg = "Unauthorized") {
    super(msg);
    this.name = "UnauthorizedError";
  }
}

export async function requireSession(): Promise<SessionData> {
  const session = await getSession();
  if (!session.isLoggedIn) {
    throw new UnauthorizedError();
  }
  return session;
}

function extractBearer(req: NextRequest): string | null {
  const header =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Allow either a logged-in operator session OR a bearer-token agent call. */
export async function requireSessionOrToken(req: NextRequest): Promise<{
  kind: "session" | "agent";
  email: string;
  role: string;
}> {
  const expected = process.env.AGENT_API_TOKEN;
  const presented = extractBearer(req);
  if (expected && presented && timingSafeEqStr(presented, expected)) {
    return { kind: "agent", email: "agent@bmasiamusic.com", role: "agent" };
  }
  const session = await getSession();
  if (!session.isLoggedIn) {
    throw new UnauthorizedError();
  }
  return { kind: "session", email: session.email, role: session.role };
}

function timingSafeEqStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ───────────────────────────── Password hashing ─────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    const actual = scryptSync(plain, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ───────────────────────────── Email allowlist ─────────────────────────────

export function isEmailAllowed(email: string): boolean {
  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(email.toLowerCase());
}

// ───────────────────────────── Debug helpers ─────────────────────────────

export function fingerprint(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
