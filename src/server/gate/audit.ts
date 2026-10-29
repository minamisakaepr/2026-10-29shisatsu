// 通行記録台帳：追記専用・ハッシュチェーン付き。
// hash = SHA-256(直前の行の hash + この行の内容)。1行でも書き換えると以降の連鎖が合わなくなる。
import { Prisma } from "@prisma/client";
import { prisma, type Db } from "../db";
import { canonicalJson, sha256 } from "../lib/crypto";

export const GENESIS_HASH = "GENESIS";
// 通行記録の書き込みを1本の列に並べるためのロック番号（数値の意味はない。他のロックとぶつからない値）
const AUDIT_LOCK_KEY = 7_243_001;

export type AuditResult = "allow" | "deny" | "error" | "info";

export interface AuditEntry {
  userId?: string | null;
  role: string;
  entrance: string;
  operation: string;
  target?: string | null;
  result: AuditResult;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

// 記録してはいけない項目（カード情報・パスワード・トークン・受け取りコードなど）
const SECRET_KEY = /pass(word)?|secret|token|card|cvc|cvv|number|code|authorization|cookie|signature/i;

export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[省略]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[伏せ字]" : scrub(x, depth + 1);
    }
    return out;
  }
  if (typeof v === "string" && v.length > 500) return `${v.slice(0, 500)}…`;
  return v;
}

export function rowPayload(r: {
  at: Date; userId: string | null; role: string; entrance: string; operation: string;
  target: string | null; result: string; ip: string | null; detail: unknown;
}) {
  return canonicalJson({
    at: r.at.toISOString(), userId: r.userId, role: r.role, entrance: r.entrance, operation: r.operation,
    target: r.target, result: r.result, ip: r.ip, detail: r.detail ?? null,
  });
}

export const chainHash = (prevHash: string, payload: string) => sha256(prevHash + payload);

async function insert(tx: Db, e: AuditEntry) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
  const last = await tx.auditLedger.findFirst({ orderBy: { seq: "desc" }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const row = {
    at: new Date(),
    userId: e.userId ?? null,
    role: e.role,
    entrance: e.entrance,
    operation: e.operation,
    target: e.target ?? null,
    result: e.result,
    ip: e.ip ?? null,
    detail: e.detail ? (scrub(e.detail) as Record<string, unknown>) : null,
  };
  const hash = chainHash(prevHash, rowPayload(row));
  await tx.auditLedger.create({
    data: { ...row, detail: (row.detail as Prisma.InputJsonValue) ?? Prisma.DbNull, prevHash, hash },
  });
}

/** 通行記録に1行追記する。tx を渡すと、その取引と同時に確定する */
export async function appendAudit(e: AuditEntry, tx?: Db) {
  if (tx && tx !== prisma) return insert(tx, e);
  return prisma.$transaction((t) => insert(t, e));
}

/** 連鎖を最初からたどって、改ざんがないか確かめる */
export async function verifyAuditChain(db: Db = prisma) {
  let prev = GENESIS_HASH;
  let cursor: bigint | undefined;
  let checked = 0;
  for (;;) {
    const rows = await db.auditLedger.findMany({
      where: cursor ? { seq: { gt: cursor } } : undefined,
      orderBy: { seq: "asc" },
      take: 1000,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      const expected = chainHash(prev, rowPayload(r));
      if (r.prevHash !== prev || r.hash !== expected) {
        return { ok: false, checked, brokenAtSeq: r.seq.toString() };
      }
      prev = r.hash;
      checked++;
    }
    cursor = rows[rows.length - 1].seq;
  }
  return { ok: true, checked, brokenAtSeq: null };
}
