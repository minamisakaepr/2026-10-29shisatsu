// 決済の流れ（与信 → 本決済 → 送金 / 解放 / 返金）。
// どの処理も「同じ要求が2回来ても1回分しか処理しない」ようにしてある：
//   ・Stripe への要求には冪等キー（例 capture:{paymentId}）
//   ・DB は「いまの状態が X のときだけ更新」＋ 仕訳の冪等キー（ユニーク）
import type { Payment } from "@prisma/client";
import { prisma } from "../db";
import { appendAudit } from "../gate/audit";
import { conflict, forbidden } from "../lib/errors";
import { canTransition, transition, type Actor } from "../domain/orderState";
import { payoutScheduledAt } from "../domain/time";
import { post } from "../money/ledger";
import type { Settings } from "../settings/definitions";
import { gateway } from "./index";

async function auditPayment(actor: Actor, action: string, target: string, detail: Record<string, unknown>) {
  await appendAudit({ userId: actor.userId, role: actor.role, entrance: `payment.${action}`, operation: "update", target, result: "info", ip: actor.ip, detail });
}

/** 与信（仮押さえ）を始める。Payment を作り、支払い画面用の clientSecret を返す */
export async function startAuthorization(orderId: string, amountJpy: number, kind: "primary" | "reauth", actor: Actor) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
  const seq = await prisma.payment.count({ where: { orderId } });
  const gw = gateway();
  const r = await gw.createAuthorization({
    amountJpy,
    orderId,
    customer: { id: order.customer.id, email: order.customer.email, stripeCustomerId: order.customer.stripeCustomerId },
    idempotencyKey: `authorize:${orderId}:${seq}`,
  });
  if (r.stripeCustomerId && r.stripeCustomerId !== order.customer.stripeCustomerId) {
    await prisma.user.update({ where: { id: order.customerId }, data: { stripeCustomerId: r.stripeCustomerId } });
  }
  const payment = await prisma.payment.upsert({
    where: { intentId: r.intentId },
    create: { orderId, provider: gw.mode, intentId: r.intentId, amountAuthorizedJpy: amountJpy, kind, active: kind === "primary" },
    update: {},
  });
  await auditPayment(actor, "authorize_start", `order:${orderId}`, { paymentId: payment.id, amountJpy, kind });
  return { payment, clientSecret: r.clientSecret, publishableKey: gw.publishableKey, mode: gw.mode };
}

/**
 * 与信が成功したときの処理（Webhook / 支払い確認ボタンのどちらから呼ばれても1回分だけ処理）
 * ・primary：注文を draft → placed にする
 * ・reauth ：金額が仮押さえを超えたときの与信やり直し。古い与信を解放し、承認済みにする
 */
export async function onAuthorized(paymentId: string): Promise<boolean> {
  const pay = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!pay || pay.status !== "requires_confirmation") return false;
  const info = await gateway().retrieveIntent(pay.intentId);
  if (info.status !== "authorized") return false;
  const system: Actor = { userId: null, role: "system" };

  const result = await prisma.$transaction(async (tx) => {
    const upd = await tx.payment.updateMany({
      where: { id: pay.id, status: "requires_confirmation" },
      data: { status: "authorized", chargeId: info.chargeId, amountAuthorizedJpy: info.amountAuthorizedJpy },
    });
    if (upd.count !== 1) return { changed: false, releaseIds: [] as string[] };
    await post(tx, { event: "hold", amountJpy: info.amountAuthorizedJpy, idempotencyKey: `hold:${pay.id}`, orderId: pay.orderId, paymentId: pay.id, stripeRef: pay.intentId });
    const order = await tx.order.findUniqueOrThrow({ where: { id: pay.orderId } });
    if (pay.kind === "primary") {
      if (order.status === "draft") {
        await transition(tx, order.id, "draft", "placed", system, "与信成功");
        return { changed: true, releaseIds: [] };
      }
      return { changed: true, releaseIds: [pay.id] }; // 期限切れなどで不要になった与信は解放
    }
    // reauth
    if (order.status !== "purchased" || order.approvalStatus !== "pending") return { changed: true, releaseIds: [pay.id] };
    const old = await tx.payment.findMany({ where: { orderId: order.id, active: true, id: { not: pay.id } } });
    await tx.payment.updateMany({ where: { orderId: order.id, active: true }, data: { active: false } });
    await tx.payment.update({ where: { id: pay.id }, data: { active: true } });
    await tx.order.update({ where: { id: order.id }, data: { approvalStatus: "approved", holdAmountJpy: info.amountAuthorizedJpy } });
    await tx.orderTransition.create({ data: { orderId: order.id, from: "purchased", to: "purchased", actorId: order.customerId, actorRole: "customer", reason: "金額変更を承認（与信をやり直し）" } });
    return { changed: true, releaseIds: old.map((o) => o.id) };
  });
  for (const id of result.releaseIds) await releasePayment(id, system, "不要になった与信の解放");
  return result.changed;
}

/** 仮押さえを解放する（キャンセル・期限切れ・与信やり直し） */
export async function releasePayment(paymentId: string, actor: Actor, reason: string) {
  const pay = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (!["authorized", "requires_confirmation"].includes(pay.status)) return;
  await gateway().cancel(pay.intentId, `cancel:${pay.id}`);
  await prisma.$transaction(async (tx) => {
    const upd = await tx.payment.updateMany({ where: { id: pay.id, status: pay.status }, data: { status: "released", active: false } });
    if (upd.count !== 1) return;
    if (pay.status === "authorized") {
      await post(tx, { event: "release", amountJpy: pay.amountAuthorizedJpy, idempotencyKey: `release:${pay.id}`, orderId: pay.orderId, paymentId: pay.id, stripeRef: pay.intentId, memo: reason });
    }
  });
  await auditPayment(actor, "release", `order:${pay.orderId}`, { paymentId: pay.id, reason });
}

/** 注文に紐づく、まだ生きている与信をすべて解放する */
export async function releaseAllForOrder(orderId: string, actor: Actor, reason: string) {
  const pays = await prisma.payment.findMany({ where: { orderId, status: { in: ["authorized", "requires_confirmation"] } } });
  for (const p of pays) await releasePayment(p.id, actor, reason);
}

/**
 * 受け取り完了 → 本決済。
 *  1. 与信を「本決済中」として確保（ここで状態を固定し、二重の本決済を防ぐ）
 *  2. Stripe で実額だけキャプチャ（冪等キー capture:{paymentId}）
 *  3. 注文を completed にし、仕訳（capture / fee / release）と送金予定を記録
 * 2 と 3 の間で止まっても、retry_captures 定期処理が同じ冪等キーでやり直す。
 */
export async function completeOrder(orderId: string, from: "delivered" | "disputed", actor: Actor, reason: string) {
  if (!canTransition(from, "completed", actor.role)) throw forbidden(`この操作はできません（${from} → completed）`, "invalid_transition");
  const pay = await prisma.$transaction(async (tx) => {
    const o = await tx.order.findUnique({ where: { id: orderId }, include: { payments: { where: { active: true } } } });
    if (!o || o.status !== from) throw conflict("注文の状態がすでに変わっています。画面を読み込み直してください", "stale_state");
    const p = o.payments[0];
    if (!p || o.finalTotalJpy == null) throw conflict("支払いの情報がありません");
    if (o.finalTotalJpy > p.amountAuthorizedJpy) throw conflict("金額が仮押さえ額を超えています。承認が必要です");
    if (p.status === "capture_pending") return p;
    const upd = await tx.payment.updateMany({
      where: { id: p.id, status: "authorized" },
      data: { status: "capture_pending", captureActorId: actor.userId, captureActorRole: actor.role, captureReason: reason },
    });
    if (upd.count !== 1) throw conflict("支払いの状態がすでに変わっています", "stale_state");
    return p;
  });
  await captureAndFinalize(pay.id);
}

/** 本決済の続き（キャプチャ → 完了の記録）。何回呼ばれても結果は1回分 */
export async function captureAndFinalize(paymentId: string) {
  const pay = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: true } });
  if (pay.status === "captured") return;
  if (pay.status !== "capture_pending") throw conflict("本決済の準備ができていません");
  const order = pay.order;
  const actor: Actor = { userId: pay.captureActorId, role: (pay.captureActorRole ?? "system") as Actor["role"] };
  const info = await gateway().capture(pay.intentId, order.finalTotalJpy!, `capture:${pay.id}`);
  const snap = order.settingsSnapshot as unknown as Settings;

  await prisma.$transaction(async (tx) => {
    const upd = await tx.payment.updateMany({
      where: { id: pay.id, status: "capture_pending" },
      data: { status: "captured", amountCapturedJpy: info.amountCapturedJpy, chargeId: info.chargeId ?? pay.chargeId },
    });
    if (upd.count !== 1) return;
    const now = new Date();
    await transition(tx, order.id, order.status, "completed", actor, pay.captureReason ?? "受け取り完了", { completedAt: now });
    const ref = { orderId: order.id, paymentId: pay.id, stripeRef: pay.intentId };
    await post(tx, { event: "capture", amountJpy: info.amountCapturedJpy, idempotencyKey: `capture:${pay.id}`, ...ref });
    await post(tx, { event: "fee", amountJpy: order.platformFeeJpy ?? 0, idempotencyKey: `fee:${pay.id}`, ...ref });
    await post(tx, { event: "release", amountJpy: pay.amountAuthorizedJpy - info.amountCapturedJpy, idempotencyKey: `release:${pay.id}:remainder`, ...ref, memo: "実額との差額の解放" });
    const run = await tx.run.findUniqueOrThrow({ where: { id: order.runId! } });
    await tx.payout.create({
      data: {
        orderId: order.id,
        runnerId: run.runnerId,
        amountJpy: info.amountCapturedJpy - (order.platformFeeJpy ?? 0),
        scheduledAt: payoutScheduledAt(now, snap.payout_timing, snap.payout_hour, snap.timezone),
      },
    });
    // 担当した注文がすべて終わったら、おつかいも終わり
    const open = await tx.order.count({ where: { runId: run.id, status: { notIn: ["completed", "cancelled"] } } });
    if (open === 0) await tx.run.update({ where: { id: run.id }, data: { status: "done" } });
  });
  await auditPayment(actor, "capture", `order:${order.id}`, { paymentId: pay.id, amountJpy: info.amountCapturedJpy });
}

/** パシリへの送金（Transfer）。冪等キー payout:{payoutId} */
export async function executePayout(payoutId: string) {
  const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { runner: true, order: { include: { payments: true } } } });
  if (payout.status !== "scheduled") return;
  const pay = payout.order.payments.find((p: Payment) => p.status === "captured");
  if (!payout.runner.stripeAccountId || !pay?.chargeId) {
    await prisma.notification.create({ data: { audience: "admin", kind: "payout_blocked", message: `送金できません（口座未登録または決済なし）: payout ${payout.id}` } });
    return;
  }
  const t = await gateway().transfer({
    amountJpy: payout.amountJpy,
    destination: payout.runner.stripeAccountId,
    sourceChargeId: pay.chargeId,
    transferGroup: payout.orderId,
    idempotencyKey: `payout:${payout.id}`,
  });
  await prisma.$transaction(async (tx) => {
    const upd = await tx.payout.updateMany({ where: { id: payout.id, status: "scheduled" }, data: { status: "paid", transferId: t.id, paidAt: new Date() } });
    if (upd.count !== 1) return;
    await post(tx, { event: "payout", amountJpy: payout.amountJpy, idempotencyKey: `payout:${payout.id}`, orderId: payout.orderId, payoutId: payout.id, stripeRef: t.id });
  });
  await auditPayment({ userId: null, role: "system" }, "payout", `order:${payout.orderId}`, { payoutId: payout.id, amountJpy: payout.amountJpy });
}

/** 返金（パシリへの送金前に限る）。送金後の返金は Stripe 上で Transfer の取り消しが必要なため、手作業で行う */
export async function refundOrder(orderId: string, actor: Actor, reason: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, payout: true } });
  const pay = order.payments.find((p) => p.status === "captured");
  if (!pay) throw conflict("本決済済みの支払いがありません");
  if (!order.payout || order.payout.status !== "scheduled") throw conflict("パシリへの送金後（または送金予定なし）は、この画面から返金できません。README の手順を見てください");
  const cancelled = await prisma.payout.updateMany({ where: { id: order.payout.id, status: "scheduled" }, data: { status: "cancelled" } });
  if (cancelled.count !== 1) throw conflict("送金の状態が変わりました。もう一度お試しください");
  const r = await gateway().refund(pay.intentId, pay.amountCapturedJpy, `refund:${pay.id}`);
  await prisma.$transaction(async (tx) => {
    const upd = await tx.payment.updateMany({ where: { id: pay.id, status: "captured" }, data: { status: "refunded", amountRefundedJpy: pay.amountCapturedJpy } });
    if (upd.count !== 1) return;
    await post(tx, { event: "refund", amountJpy: pay.amountCapturedJpy, feeJpy: order.platformFeeJpy ?? 0, idempotencyKey: `refund:${pay.id}`, orderId, paymentId: pay.id, stripeRef: r.refundId, memo: reason });
  });
  await auditPayment(actor, "refund", `order:${orderId}`, { paymentId: pay.id, amountJpy: pay.amountCapturedJpy, reason });
  return pay.amountCapturedJpy;
}
