// 定期処理。worker.ts が設定値 job_interval_seconds ごとに呼ぶ。admin 画面からも手動で動かせる。
// どれも何回動いても結果が変わらない（冪等）ように作ってある。
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { transition, type Actor } from "../domain/orderState";
import { autoCompleteAt } from "../domain/orders";
import { zonedDate } from "../domain/time";
import { setJobs, type JobFn } from "../gate/jobs";
import { isBalanced } from "../money/ledger";
import { gateway } from "../payments";
import { captureAndFinalize, completeOrder, executePayout, releaseAllForOrder } from "../payments/service";
import { resolveSettings } from "../settings/service";

const SYSTEM: Actor = { userId: null, role: "system" };

async function each<T>(items: T[], fn: (x: T) => Promise<void>) {
  let ok = 0;
  const failed: string[] = [];
  for (const x of items) {
    try {
      await fn(x);
      ok++;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { ok, failed: failed.length, errors: failed.slice(0, 5) };
}

/** 誰も引き受けない注文（と、支払いが終わらなかった下書き）を期限切れにして、仮押さえを解放 */
export async function expireOrders(now = new Date()) {
  const orders = await prisma.order.findMany({ where: { status: { in: ["draft", "placed"] }, expiresAt: { lte: now } }, take: 200 });
  return each(orders, async (o) => {
    await prisma.$transaction((tx) => transition(tx, o.id, o.status, "expired", SYSTEM, "期限切れ"));
    await releaseAllForOrder(o.id, SYSTEM, "期限切れ");
  });
}

/** 配達後、注文時点の auto_complete_minutes が過ぎた注文を自動で受け取り完了（本決済） */
export async function autoComplete(now = new Date()) {
  const orders = await prisma.order.findMany({ where: { status: "delivered" }, take: 500 });
  const due = orders.filter((o) => autoCompleteAt(o)! <= now);
  return each(due, (o) => completeOrder(o.id, "delivered", SYSTEM, "自動完了"));
}

/** 本決済の途中で止まったものを、同じ冪等キーでやり直す */
export async function retryCaptures(now = new Date()) {
  const stuck = await prisma.payment.findMany({ where: { status: "capture_pending", updatedAt: { lte: new Date(now.getTime() - 60_000) } }, take: 100 });
  return each(stuck, (p) => captureAndFinalize(p.id));
}

/** 送金予定の時刻を過ぎたものを送金 */
export async function payouts(now = new Date()) {
  const due = await prisma.payout.findMany({ where: { status: "scheduled", scheduledAt: { lte: now } }, take: 200 });
  return each(due, (p) => executePayout(p.id));
}

/** お金の台帳と Stripe（またはモック）の記録を突き合わせる。差異があれば admin に通知 */
export async function reconcile() {
  const gw = gateway();
  const issues: Record<string, unknown>[] = [];
  let checked = 0;

  // 1. 仕訳ごとに借方と貸方が一致しているか
  const journals = await prisma.moneyJournal.findMany({ include: { lines: true } });
  for (const j of journals) {
    checked++;
    if (!isBalanced(j.lines)) issues.push({ kind: "unbalanced_journal", journal: j.id });
  }

  // 2. 支払いごとに、台帳・DB・Stripe の金額と状態が合っているか
  const sumBy = (paymentId: string, ev: string) =>
    journals.filter((j) => j.paymentId === paymentId && j.eventType === ev).reduce((s, j) => s + j.amountJpy, 0);
  const pays = await prisma.payment.findMany({ where: { provider: gw.mode, status: { not: "requires_confirmation" } } });
  for (const p of pays) {
    checked++;
    let remote;
    try {
      remote = await gw.retrieveIntent(p.intentId);
    } catch (e) {
      issues.push({ kind: "missing_remote_intent", payment: p.id, error: String(e) });
      continue;
    }
    const hold = sumBy(p.id, "hold");
    const captured = sumBy(p.id, "capture");
    const released = sumBy(p.id, "release");
    const expectStatus = { authorized: "authorized", capture_pending: "authorized", captured: "captured", refunded: "captured", released: "canceled" }[p.status as string];
    if (expectStatus && remote.status !== expectStatus) issues.push({ kind: "status_mismatch", payment: p.id, ours: p.status, stripe: remote.status });
    // 与信の前に取り消された支払い（released で hold なし）・失敗した支払いには仕訳がない
    const neverHeld = (p.status === "released" && hold === 0) || p.status === "failed";
    if (!neverHeld && hold !== p.amountAuthorizedJpy) issues.push({ kind: "hold_mismatch", payment: p.id, ledger: hold, ours: p.amountAuthorizedJpy });
    if (["captured", "refunded"].includes(p.status)) {
      if (captured !== p.amountCapturedJpy || remote.amountCapturedJpy !== p.amountCapturedJpy) {
        issues.push({ kind: "capture_mismatch", payment: p.id, ledger: captured, ours: p.amountCapturedJpy, stripe: remote.amountCapturedJpy });
      }
      if (hold !== captured + released) issues.push({ kind: "hold_not_settled", payment: p.id, hold, captured, released });
    }
    if (p.status === "released" && hold !== released) issues.push({ kind: "release_mismatch", payment: p.id, hold, released });
    if (p.status === "refunded" && remote.amountRefundedJpy !== p.amountRefundedJpy) {
      issues.push({ kind: "refund_mismatch", payment: p.id, ours: p.amountRefundedJpy, stripe: remote.amountRefundedJpy });
    }
  }

  // 3. 送金ごとに、台帳・DB・Stripe の金額が合っているか
  const paid = await prisma.payout.findMany({ where: { status: "paid" } });
  for (const po of paid) {
    checked++;
    const ledger = journals.filter((j) => j.payoutId === po.id && j.eventType === "payout").reduce((s, j) => s + j.amountJpy, 0);
    try {
      const t = await gw.retrieveTransfer(po.transferId!);
      if (t.amountJpy !== po.amountJpy || ledger !== po.amountJpy || t.reversed) {
        issues.push({ kind: "payout_mismatch", payout: po.id, ours: po.amountJpy, ledger, stripe: t.amountJpy, reversed: t.reversed });
      }
    } catch (e) {
      issues.push({ kind: "missing_remote_transfer", payout: po.id, error: String(e) });
    }
  }

  const status = issues.length ? "mismatch" : "ok";
  await prisma.reconciliationRun.create({ data: { status, checked, details: issues as Prisma.InputJsonValue } });
  if (issues.length) {
    await prisma.notification.create({
      data: { audience: "admin", kind: "reconcile_mismatch", message: `Stripe との照合で ${issues.length} 件の差異が見つかりました`, detail: issues.slice(0, 50) as Prisma.InputJsonValue },
    });
  }
  return { status, checked, issues: issues.length };
}

/** 照合は1日1回。その日（設定値 timezone）にまだ動いていなければ true */
export async function reconcileDue(now = new Date()) {
  const s = await resolveSettings();
  const last = await prisma.reconciliationRun.findFirst({ orderBy: { at: "desc" } });
  return !last || zonedDate(last.at, s.timezone) !== zonedDate(now, s.timezone);
}

export const JOBS: Record<string, JobFn> = {
  "job.expire_orders": () => expireOrders(),
  "job.auto_complete": () => autoComplete(),
  "job.retry_captures": () => retryCaptures(),
  "job.payouts": () => payouts(),
  "job.reconcile": () => reconcile(),
};

export function registerJobs() {
  setJobs(JOBS);
}
