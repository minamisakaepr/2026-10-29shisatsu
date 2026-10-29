// お金の台帳（複式簿記）。1つのイベント＝1つの仕訳。残高は直接書き換えず、仕訳を追記するだけ。
// 勘定科目と仕訳の対応は docs/design.md「7. お金の台帳」を参照。
import type { Tx } from "../db";
import { prisma, type Db } from "../db";

export const ACCOUNTS = {
  holdAuthorized: "hold:authorized",
  holdCommitment: "hold:customer_commitment",
  stripeBalance: "stripe:platform_balance",
  runnerPayable: "payable:runner",
  platformFee: "revenue:platform_fee",
} as const;

export type MoneyEvent = "hold" | "release" | "capture" | "fee" | "payout" | "refund";

export interface Line {
  account: string;
  debitJpy?: number;
  creditJpy?: number;
}

const A = ACCOUNTS;

/** イベントごとの仕訳の形（借方・貸方）。ここ以外で仕訳の形を決めない */
export function linesFor(event: MoneyEvent, amountJpy: number, extra: { feeJpy?: number } = {}): Line[] {
  switch (event) {
    case "hold":
      return [{ account: A.holdAuthorized, debitJpy: amountJpy }, { account: A.holdCommitment, creditJpy: amountJpy }];
    case "release":
      return [{ account: A.holdCommitment, debitJpy: amountJpy }, { account: A.holdAuthorized, creditJpy: amountJpy }];
    case "capture":
      return [
        { account: A.holdCommitment, debitJpy: amountJpy },
        { account: A.holdAuthorized, creditJpy: amountJpy },
        { account: A.stripeBalance, debitJpy: amountJpy },
        { account: A.runnerPayable, creditJpy: amountJpy },
      ];
    case "fee":
      return [{ account: A.runnerPayable, debitJpy: amountJpy }, { account: A.platformFee, creditJpy: amountJpy }];
    case "payout":
      return [{ account: A.runnerPayable, debitJpy: amountJpy }, { account: A.stripeBalance, creditJpy: amountJpy }];
    case "refund": {
      const fee = extra.feeJpy ?? 0;
      return [
        { account: A.runnerPayable, debitJpy: amountJpy - fee },
        ...(fee > 0 ? [{ account: A.platformFee, debitJpy: fee }] : []),
        { account: A.stripeBalance, creditJpy: amountJpy },
      ];
    }
  }
}

export function isBalanced(lines: Line[]): boolean {
  const d = lines.reduce((s, l) => s + (l.debitJpy ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.creditJpy ?? 0), 0);
  return d === c && lines.every((l) => (l.debitJpy ?? 0) >= 0 && (l.creditJpy ?? 0) >= 0);
}

export interface PostInput {
  event: MoneyEvent;
  amountJpy: number;
  idempotencyKey: string;
  orderId?: string | null;
  paymentId?: string | null;
  payoutId?: string | null;
  stripeRef?: string | null;
  memo?: string;
  feeJpy?: number;
}

/**
 * 仕訳を1件追記する。同じ冪等キーの仕訳がすでにあれば何もしない（二重計上の防止）。
 * 金額 0 の仕訳は作らない。
 */
export async function post(tx: Tx, p: PostInput): Promise<boolean> {
  if (!Number.isInteger(p.amountJpy) || p.amountJpy < 0) throw new Error("仕訳の金額が不正です");
  if (p.amountJpy === 0) return false;
  const exists = await tx.moneyJournal.findUnique({ where: { idempotencyKey: p.idempotencyKey }, select: { id: true } });
  if (exists) return false;
  const lines = linesFor(p.event, p.amountJpy, { feeJpy: p.feeJpy });
  if (!isBalanced(lines)) throw new Error(`仕訳の借方と貸方が一致しません (${p.event})`);
  await tx.moneyJournal.create({
    data: {
      eventType: p.event, amountJpy: p.amountJpy, idempotencyKey: p.idempotencyKey, orderId: p.orderId ?? null,
      paymentId: p.paymentId ?? null, payoutId: p.payoutId ?? null, stripeRef: p.stripeRef ?? null, memo: p.memo ?? "",
      lines: { create: lines.map((l) => ({ account: l.account, debitJpy: l.debitJpy ?? 0, creditJpy: l.creditJpy ?? 0 })) },
    },
  });
  return true;
}

/** 勘定科目ごとの残高（借方 − 貸方） */
export async function balances(db: Db = prisma): Promise<Record<string, number>> {
  const rows = await db.moneyLine.groupBy({ by: ["account"], _sum: { debitJpy: true, creditJpy: true } });
  return Object.fromEntries(rows.map((r) => [r.account, (r._sum.debitJpy ?? 0) - (r._sum.creditJpy ?? 0)]));
}
