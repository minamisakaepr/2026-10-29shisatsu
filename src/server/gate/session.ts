// ログイン状態（セッション）と CSRF 対策
import { prisma } from "../db";
import { randomToken, safeEqual, sha256 } from "../lib/crypto";
import type { LedgerRole } from "./ledger";

export const SESSION_COOKIE = "pashiri_session";
export const CSRF_COOKIE = "pashiri_csrf";
export const CSRF_HEADER = "x-csrf-token";

export interface Principal {
  userId: string | null;
  sessionId: string | null;
  roles: LedgerRole[]; // 未ログインなら ["anonymous"]
}

export const ANONYMOUS: Principal = { userId: null, sessionId: null, roles: ["anonymous"] };
export const SYSTEM: Principal = { userId: null, sessionId: null, roles: ["system"] };

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export async function principalFromToken(token: string | null): Promise<Principal> {
  if (!token || token.length > 200) return ANONYMOUS;
  const s = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { roles: true } } },
  });
  if (!s || s.expiresAt < new Date() || s.user.disabledAt || !s.user.emailVerifiedAt) return ANONYMOUS;
  const roles = s.user.roles.map((r) => r.role as LedgerRole);
  if (roles.length === 0) return ANONYMOUS;
  return { userId: s.userId, sessionId: s.id, roles };
}

export async function createSession(userId: string, ttlHours: number, ip: string | null) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await prisma.session.create({ data: { userId, tokenHash: sha256(token), expiresAt, ip } });
  return { token, expiresAt };
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function csrfCookie(token: string, secure: boolean) {
  // 画面の JavaScript が読んでヘッダーに付けるため HttpOnly にしない（二重送信クッキー方式）
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** 書き込み系リクエストの CSRF チェック：Origin が自分のサイトで、クッキーとヘッダーのトークンが一致すること */
export function checkCsrf(req: Request, appUrl: string): string | null {
  const origin = req.headers.get("origin");
  const expected = new URL(appUrl).origin;
  if (!origin) return "Origin ヘッダーがありません";
  if (origin !== expected) return `Origin が違います (${origin})`;
  const cookie = readCookie(req.headers.get("cookie"), CSRF_COOKIE);
  const header = req.headers.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header)) return "CSRF トークンが一致しません";
  return null;
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || null;
}
