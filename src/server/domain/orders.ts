// 注文〜受け取りの業務ルール。権限（だれが・どの範囲）は門番が確認済みの前提で、ここでは業務上の条件を見る。
import { Prisma, type Order } from "@prisma/client";
import { prisma } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { safeEqual, sixDigitCode } from "../lib/crypto";
import { saveReceipt } from "../lib/storage";
import { gateway } from "../payments";
import { completeOrder, onAuthorized, releaseAllForOrder, startAuthorization } from "../payments/service";
import { resolveForShop } from "../settings/service";
import type { Settings } from "../settings/definitions";
import { distanceKm } from "./geo";
import { transition, type Actor } from "./orderState";
import { approvalReasons, estimateOrder, finalAmounts, runReward, type RunOrderInput } from "./pricing";
import { addMinutes, inTimeRange } from "./time";

export const snapshotOf = (o: Pick<Order, "settingsSnapshot">) => o.settingsSnapshot as unknown as Settings;

export function cancelDeadline(o: Pick<Order, "matchedAt" | "settingsSnapshot">): Date | null {
  return o.matchedAt ? addMinutes(o.matchedAt, snapshotOf(o).cancel_deadline_minutes) : null;
}

export function autoCompleteAt(o: Pick<Order, "deliveredAt" | "settingsSnapshot">): Date | null {
  return o.deliveredAt ? addMinutes(o.deliveredAt, snapshotOf(o).auto_complete_minutes) : null;
}

async function notifyAdmin(kind: string, message: string, detail?: Record<string, unknown>) {
  await prisma.notification.create({ data: { audience: "admin", kind, message, detail: (detail as Prisma.InputJsonValue) ?? Prisma.DbNull } });
}

// ------------------------------------------------------------------
// お客さん：注文
// ------------------------------------------------------------------

export interface CreateOrderInput {
  shopId: string;
  items: { productId: string; qty: number }[];
  dropoffLabel: string;
  dropoffLat?: number;
  dropoffLng?: number;
  note?: string;
}

export async function createOrder(actor: Actor & { userId: string }, input: CreateOrderInput, now = new Date()) {
  const shop = await prisma.shop.findFirst({ where: { id: input.shopId, active: true } });
  if (!shop) throw notFound("店が見つかりません");
  const customer = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  const lat = input.dropoffLat ?? customer.lat;
  const lng = input.dropoffLng ?? customer.lng;
  if (lat == null || lng == null) throw badRequest("受け渡し場所の位置がわかりません");

  // この時点の設定値（店舗別 ＞ エリア別 ＞ 全体）＝この注文のスナップショット
  const s = await resolveForShop(shop.id);
  const qtySum = input.items.reduce((a, i) => a + i.qty, 0);
  if (qtySum > s.max_items_per_order) throw badRequest(`1回の注文は ${s.max_items_per_order} 点までです`);
  const ids = [...new Set(input.items.map((i) => i.productId))];
  if (ids.length !== input.items.length) throw badRequest("同じ商品が重複しています");
  const products = await prisma.product.findMany({ where: { id: { in: ids }, shopId: shop.id, active: true } });
  if (products.length !== ids.length) throw badRequest("注文できない商品が含まれています");

  const dist = distanceKm(shop, { lat, lng });
  if (dist > s.service_radius_km) throw badRequest(`受け渡し場所が対応エリア（店から ${s.service_radius_km}km）の外です`);

  const lines = input.items.map((i) => {
    const p = products.find((x) => x.id === i.productId)!;
    return { productId: p.id, name: p.name, unitPriceJpy: p.priceJpy, qty: i.qty };
  });
  const est = estimateOrder(s, lines, { isRain: s.rain_active, isEarly: inTimeRange(now, s.early_hours, s.timezone), distanceKm: dist });

  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.order.create({
      data: {
        customerId: actor.userId, shopId: shop.id, dropoffLabel: input.dropoffLabel, dropoffLat: lat, dropoffLng: lng,
        distanceKm: dist, note: input.note ?? "", settingsSnapshot: s as unknown as Prisma.InputJsonValue,
        estimatedItemsJpy: est.itemsJpy, estimatedDeliveryFeeJpy: est.deliveryFeeJpy, estimatedPlatformFeeJpy: est.platformFeeJpy,
        estimatedTotalJpy: est.totalJpy, holdAmountJpy: est.holdJpy, expiresAt: addMinutes(now, s.order_expire_minutes),
        items: { create: lines },
      },
    });
    await tx.orderTransition.create({ data: { orderId: o.id, from: "draft", to: "draft", actorId: actor.userId, actorRole: "customer", reason: "注文を作成" } });
    return o;
  });
  const auth = await startAuthorization(order.id, est.holdJpy, "primary", actor);
  return { order, auth };
}

/** 支払い画面で確定したあとに呼ぶ。与信が成功していれば注文を確定する（モックではここで「テストカードで支払い」） */
export async function confirmPayment(orderId: string) {
  const pays = await prisma.payment.findMany({ where: { orderId, status: "requires_confirmation" }, orderBy: { createdAt: "desc" } });
  for (const p of pays) {
    const gw = gateway();
    if (gw.mockConfirm) await gw.mockConfirm(p.intentId);
    await onAuthorized(p.id);
  }
  return prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, status: true } });
}

export async function cancelByCustomer(orderId: string, actor: Actor, now = new Date()) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.status === "matched") {
    const dl = cancelDeadline(o)!;
    if (now > dl) throw conflict("パシリが引き受けてから時間がたったため、キャンセルできません。トラブルの場合は運営に連絡してください");
  } else if (o.status !== "placed") {
    throw conflict("この状態ではキャンセルできません");
  }
  await prisma.$transaction((tx) => transition(tx, o.id, o.status, "cancelled", actor, "お客さんがキャンセル", { cancelledAt: now }));
  await releaseAllForOrder(o.id, actor, "キャンセル");
  if (o.runId) await closeRunIfFinished(o.runId);
  return { id: o.id, status: "cancelled" };
}

async function closeRunIfFinished(runId: string) {
  const open = await prisma.order.count({ where: { runId, status: { notIn: ["completed", "cancelled"] } } });
  if (open === 0) await prisma.run.updateMany({ where: { id: runId, status: { in: ["shopping", "delivering"] } }, data: { status: "done" } });
}

/** 金額の変更・代替品の承認／拒否 */
export async function approveByCustomer(orderId: string, decision: "approve" | "reject", note: string, actor: Actor & { userId: string }) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.status !== "purchased" || o.approvalStatus !== "pending") throw conflict("承認待ちではありません");
  if (decision === "reject") {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: o.id }, data: { approvalStatus: "rejected" } });
      await transition(tx, o.id, "purchased", "disputed", actor, "お客さんが金額・代替品を拒否");
      await tx.dispute.create({ data: { orderId: o.id, openedById: actor.userId, openedByRole: "customer", fromStatus: "purchased", reason: note || "金額・代替品の拒否" } });
    });
    await notifyAdmin("dispute", `注文 ${o.id} で金額・代替品が拒否されました`);
    return { order: { id: o.id, status: "disputed", approvalStatus: "rejected" }, payment: null };
  }
  const active = await prisma.payment.findFirst({ where: { orderId: o.id, active: true, status: "authorized" } });
  if (active && o.finalTotalJpy! <= active.amountAuthorizedJpy) {
    await prisma.$transaction(async (tx) => {
      const upd = await tx.order.updateMany({ where: { id: o.id, approvalStatus: "pending" }, data: { approvalStatus: "approved" } });
      if (upd.count !== 1) throw conflict("承認待ちではありません");
      await tx.orderTransition.create({ data: { orderId: o.id, from: "purchased", to: "purchased", actorId: actor.userId, actorRole: "customer", reason: "金額・代替品を承認" } });
    });
    return { order: { id: o.id, status: o.status, approvalStatus: "approved" }, payment: null };
  }
  // 仮押さえ額を超える → 新しい金額で与信をやり直す（お客さんが支払い画面で確定する）
  const auth = await startAuthorization(o.id, o.finalTotalJpy!, "reauth", actor);
  return { order: { id: o.id, status: o.status, approvalStatus: "pending" }, payment: auth };
}

export async function receiveByCustomer(orderId: string, actor: Actor) {
  await completeOrder(orderId, "delivered", actor, "お客さんが受け取りを確認");
  return prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, status: true, finalTotalJpy: true } });
}

export async function openDispute(orderId: string, reason: string, actor: Actor & { userId: string; role: "customer" | "runner" }) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { where: { active: true } } } });
  if (o.payments.some((p) => p.status === "capture_pending")) throw conflict("本決済の処理中です。少し待ってから画面を読み込み直してください");
  if (!["purchased", "delivered"].includes(o.status)) throw conflict("この状態ではトラブル申告できません。運営に直接連絡してください");
  await prisma.$transaction(async (tx) => {
    await transition(tx, o.id, o.status, "disputed", actor, reason);
    await tx.dispute.create({ data: { orderId: o.id, openedById: actor.userId, openedByRole: actor.role, fromStatus: o.status, reason } });
  });
  await notifyAdmin("dispute", `注文 ${o.id} でトラブル申告がありました`, { by: actor.role });
  return { id: o.id, status: "disputed" };
}

export async function rateRunner(orderId: string, stars: number, message: string, customerId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { run: true, rating: true } });
  if (o.status !== "completed" || !o.run) throw conflict("受け取り完了後に評価できます");
  if (o.rating) throw conflict("すでに評価済みです");
  await prisma.rating.create({ data: { orderId, customerId, runnerId: o.run.runnerId, stars, message } });
  return { ok: true };
}

// ------------------------------------------------------------------
// パシリ：まとめて引き受け〜配達
// ------------------------------------------------------------------

async function loadRunCandidates(orderIds: string[], scopeWhere: Record<string, unknown>, runnerId: string) {
  const unique = [...new Set(orderIds)];
  if (unique.length !== orderIds.length) throw badRequest("同じ注文が重複しています");
  // 門番が作ったデータ範囲（nearby：引き受け待ち・自分の注文以外）で絞る
  const orders = await prisma.order.findMany({ where: { AND: [{ id: { in: unique } }, scopeWhere as Prisma.OrderWhereInput] } });
  if (orders.length !== unique.length) throw conflict("引き受けられない注文が含まれています（すでに引き受け済み・期限切れなど）");
  // 念のため、ここでも自分の注文でないことを確かめる（二重の守り）
  if (orders.some((o) => o.customerId === runnerId)) throw forbidden("自分の注文は引き受けられません", "self_accept");
  const shopIds = new Set(orders.map((o) => o.shopId));
  if (shopIds.size !== 1) throw badRequest("まとめられるのは同じ店の注文だけです");
  const shopId = orders[0].shopId;
  // 上限は「いまの設定値」（設定を厳しくしたらすぐ効くように）
  const current = await resolveForShop(shopId);
  if (orders.length > current.max_orders_per_run) throw badRequest(`1回にまとめられるのは ${current.max_orders_per_run} 件までです`);
  const advanceJpy = orders.reduce((s, o) => s + o.estimatedItemsJpy, 0);
  if (advanceJpy > current.runner_advance_limit_jpy) {
    throw badRequest(`立て替えの合計（見積 ${advanceJpy}円）が上限 ${current.runner_advance_limit_jpy}円 を超えます`);
  }
  return { orders, shopId, advanceJpy };
}

function rewardFor(orders: Order[], now: Date) {
  const inputs: RunOrderInput[] = orders.map((o) => {
    const s = snapshotOf(o);
    return { orderId: o.id, settings: s, distanceKm: o.distanceKm, isRain: s.rain_active, isEarly: inTimeRange(now, s.early_hours, s.timezone) };
  });
  return { reward: runReward(inputs), inputs };
}

export async function previewRun(orderIds: string[], scopeWhere: Record<string, unknown>, runnerId: string, now = new Date()) {
  const { orders, advanceJpy } = await loadRunCandidates(orderIds, scopeWhere, runnerId);
  const { reward, inputs } = rewardFor(orders, now);
  return {
    rewardJpy: reward.rewardJpy,
    breakdown: reward.perOrder.map((p) => ({ orderId: p.orderId, deliveryFeeJpy: p.deliveryFeeJpy, ...p.fee.detail, sharedPartJpy: p.fee.sharedPartJpy, perOrderJpy: p.fee.perOrderJpy })),
    advanceJpy,
    isRain: inputs.some((i) => i.isRain),
    isEarly: inputs.some((i) => i.isEarly),
    distanceKm: reward.distanceKm,
  };
}

export async function createRun(orderIds: string[], scopeWhere: Record<string, unknown>, actor: Actor & { userId: string }, now = new Date()) {
  const runner = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!runner.payoutsEnabled || !runner.stripeAccountId) throw forbidden("先に報酬の受け取り口座を登録してください", "payouts_disabled");
  const { orders, shopId } = await loadRunCandidates(orderIds, scopeWhere, actor.userId);
  const { reward, inputs } = rewardFor(orders, now);
  return prisma.$transaction(async (tx) => {
    const run = await tx.run.create({
      data: {
        runnerId: actor.userId, shopId, rewardJpy: reward.rewardJpy, distanceKm: reward.distanceKm,
        isRain: inputs.some((i) => i.isRain), isEarly: inputs.some((i) => i.isEarly),
        rewardBreakdown: reward.perOrder.map((p) => ({ orderId: p.orderId, deliveryFeeJpy: p.deliveryFeeJpy, ...p.fee.detail })) as Prisma.InputJsonValue,
      },
    });
    for (const p of reward.perOrder) {
      await transition(tx, p.orderId, "placed", "matched", actor, "パシリが引き受け", {
        runId: run.id, matchedAt: now, deliveryFeeJpy: p.deliveryFeeJpy, receiveCode: sixDigitCode(), receiveCodeAttempts: 0,
      });
    }
    return { id: run.id };
  });
}

export async function withdrawRun(runId: string, actor: Actor, now = new Date()) {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { orders: true } });
  if (run.status !== "shopping") throw conflict("買い物が終わったあとは取り消せません");
  const active = run.orders.filter((o) => o.status === "matched");
  if (run.orders.some((o) => o.status === "purchased")) throw conflict("買い物が終わった注文があります");
  if (active.some((o) => now > cancelDeadline(o)!)) throw conflict("引き受けてから時間がたったため、取り消せません。運営に連絡してください");
  await prisma.$transaction(async (tx) => {
    for (const o of active) {
      await transition(tx, o.id, "matched", "placed", actor, "パシリが辞退", { runId: null, matchedAt: null, deliveryFeeJpy: null, receiveCode: null });
    }
    await tx.run.update({ where: { id: run.id }, data: { status: "withdrawn" } });
  });
  return { id: run.id, status: "withdrawn" };
}

export interface ReceiptInput {
  orders: {
    orderId: string;
    items: { itemId: string; actualUnitPriceJpy: number; actualQty: number; outOfStock: boolean; substitutionName?: string | null }[];
  }[];
}

export async function registerReceipt(runId: string, image: Buffer, input: ReceiptInput, actor: Actor & { userId: string }, now = new Date()) {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { orders: { include: { items: true } } } });
  if (run.status !== "shopping") throw conflict("レシートはすでに登録済みです");
  const targets = run.orders.filter((o) => o.status === "matched");
  if (targets.length === 0) throw conflict("買い物する注文がありません");
  const byId = new Map(input.orders.map((o) => [o.orderId, o]));
  if (byId.size !== targets.length || targets.some((o) => !byId.has(o.id))) throw badRequest("すべての注文の実額を入力してください");

  const plans = targets.map((o) => {
    const given = byId.get(o.id)!;
    const items = new Map(given.items.map((i) => [i.itemId, i]));
    if (items.size !== o.items.length || o.items.some((i) => !items.has(i.id))) throw badRequest("すべての商品の実額を入力してください");
    let actualItemsJpy = 0;
    let hasSub = false;
    let hasOut = false;
    for (const it of o.items) {
      const a = items.get(it.id)!;
      if (a.outOfStock) hasOut = true;
      if (a.substitutionName) hasSub = true;
      if (!a.outOfStock) actualItemsJpy += a.actualUnitPriceJpy * a.actualQty;
    }
    const s = snapshotOf(o);
    const fin = finalAmounts(s, actualItemsJpy, o.deliveryFeeJpy!);
    const reasons = approvalReasons(s, {
      estimatedItemsJpy: o.estimatedItemsJpy, actualItemsJpy, finalTotalJpy: fin.totalJpy, holdJpy: o.holdAmountJpy, hasSubstitution: hasSub, hasOutOfStock: hasOut,
    });
    return { order: o, items, fin, reasons };
  });

  const current = await resolveForShop(run.shopId);
  const saved = await saveReceipt(image, current.receipt_max_bytes);
  return prisma.$transaction(async (tx) => {
    await tx.receipt.create({ data: { runId: run.id, uploadedById: actor.userId, ...saved } });
    for (const p of plans) {
      for (const it of p.order.items) {
        const a = p.items.get(it.id)!;
        await tx.orderItem.update({
          where: { id: it.id },
          data: { actualUnitPriceJpy: a.actualUnitPriceJpy, actualQty: a.outOfStock ? 0 : a.actualQty, outOfStock: a.outOfStock, substitutionName: a.substitutionName || null },
        });
      }
      await transition(tx, p.order.id, "matched", "purchased", actor, p.reasons.length ? `レシート登録（承認が必要: ${p.reasons.join(",")}）` : "レシート登録", {
        purchasedAt: now, actualItemsJpy: p.fin.itemsJpy, platformFeeJpy: p.fin.platformFeeJpy, finalTotalJpy: p.fin.totalJpy,
        approvalStatus: p.reasons.length ? "pending" : "none", approvalReasons: p.reasons,
      });
    }
    await tx.run.update({ where: { id: run.id }, data: { status: "delivering" } });
    return {
      id: run.id,
      orders: plans.map((p) => ({ id: p.order.id, status: "purchased", approvalStatus: p.reasons.length ? "pending" : "none" })),
    };
  });
}

export async function deliver(orderId: string, actor: Actor, now = new Date()) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.status === "purchased" && o.approvalStatus === "pending") throw conflict("お客さんの承認待ちです");
  if (o.status === "purchased" && o.approvalStatus === "rejected") throw conflict("お客さんが拒否したため、運営の対応を待ってください");
  await prisma.$transaction((tx) => transition(tx, o.id, "purchased", "delivered", actor, "パシリが届けた", { deliveredAt: now }));
  return { id: o.id, status: "delivered" };
}

/** パシリが、お客さんの受け取りコード（QR）を読み取って受け取り完了にする */
export async function receiveByRunner(orderId: string, code: string, actor: Actor) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.status !== "delivered") throw conflict("「届けた」にしてから受け取りコードを読み取ってください");
  const s = snapshotOf(o);
  if (o.receiveCodeAttempts >= s.receive_code_max_attempts) {
    throw forbidden("受け取りコードの入力回数の上限を超えました。お客さんに受け取りボタンを押してもらってください", "code_locked");
  }
  if (!o.receiveCode || !safeEqual(o.receiveCode, code)) {
    const upd = await prisma.order.update({ where: { id: o.id }, data: { receiveCodeAttempts: { increment: 1 } } });
    if (upd.receiveCodeAttempts >= s.receive_code_max_attempts) {
      await notifyAdmin("receive_code_locked", `注文 ${o.id} の受け取りコードが上限回数まで間違えられました`);
    }
    throw badRequest("受け取りコードが違います", "wrong_code");
  }
  await completeOrder(orderId, "delivered", actor, "パシリが受け取りコードを確認");
  return { id: o.id, status: "completed" };
}

// ------------------------------------------------------------------
// 運営：トラブル対応
// ------------------------------------------------------------------

export async function resolveDispute(disputeId: string, resolution: "complete" | "cancel", note: string, actor: Actor & { userId: string }) {
  const d = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId }, include: { order: true } });
  if (d.status !== "open") throw conflict("すでに解決済みです");
  const o = d.order;
  if (o.status !== "disputed") throw conflict("注文がトラブル対応中ではありません");
  if (resolution === "complete") {
    await completeOrder(o.id, "disputed", actor, `運営が完了: ${note}`);
  } else {
    await prisma.$transaction((tx) => transition(tx, o.id, "disputed", "cancelled", actor, `運営がキャンセル: ${note}`, { cancelledAt: new Date() }));
    await releaseAllForOrder(o.id, actor, "トラブル対応でキャンセル");
    if (o.runId) await closeRunIfFinished(o.runId);
  }
  // 同じ注文の未解決の申告はまとめて解決にする
  await prisma.dispute.updateMany({ where: { orderId: o.id, status: "open" }, data: { status: "resolved", resolution: `${resolution}: ${note}`, resolvedById: actor.userId, resolvedAt: new Date() } });
  const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  return { id: d.id, status: "resolved", orderStatus: after.status };
}
