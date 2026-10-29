// 注文の状態遷移。表にない遷移はすべて拒否する。表の説明は docs/design.md「3. 注文の状態遷移」。
import type { OrderStatus, Prisma } from "@prisma/client";
import type { Tx } from "../db";
import { appendAudit } from "../gate/audit";
import { conflict, forbidden } from "../lib/errors";

export type ActorRole = "customer" | "runner" | "admin" | "system";

export const TRANSITIONS: { from: OrderStatus; to: OrderStatus; by: ActorRole[] }[] = [
  { from: "draft", to: "placed", by: ["system"] },
  { from: "draft", to: "expired", by: ["system"] },
  { from: "placed", to: "matched", by: ["runner"] },
  { from: "placed", to: "cancelled", by: ["customer"] },
  { from: "placed", to: "expired", by: ["system"] },
  { from: "matched", to: "placed", by: ["runner"] },
  { from: "matched", to: "cancelled", by: ["customer"] },
  { from: "matched", to: "purchased", by: ["runner"] },
  { from: "purchased", to: "delivered", by: ["runner"] },
  { from: "purchased", to: "disputed", by: ["customer", "runner"] },
  { from: "delivered", to: "completed", by: ["customer", "runner", "system"] },
  { from: "delivered", to: "disputed", by: ["customer"] },
  { from: "disputed", to: "completed", by: ["admin"] },
  { from: "disputed", to: "cancelled", by: ["admin"] },
];

export function canTransition(from: OrderStatus, to: OrderStatus, by: ActorRole): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.by.includes(by));
}

export interface Actor {
  userId: string | null;
  role: ActorRole;
  ip?: string | null;
}

/**
 * 状態を from → to に変える。
 * ・表にない遷移は拒否（403）
 * ・「いまの状態が from のときだけ」更新するので、同時に操作されても二重に進まない（409）
 * ・遷移の記録（OrderTransition）と通行記録を同じ取引で残す
 */
export async function transition(
  tx: Tx,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  actor: Actor,
  reason = "",
  data: Prisma.OrderUncheckedUpdateManyInput = {},
) {
  if (!canTransition(from, to, actor.role)) {
    throw forbidden(`この操作はできません（${from} → ${to}）`, "invalid_transition");
  }
  const res = await tx.order.updateMany({ where: { id: orderId, status: from }, data: { ...data, status: to } });
  if (res.count !== 1) throw conflict("注文の状態がすでに変わっています。画面を読み込み直してください", "stale_state");
  await tx.orderTransition.create({ data: { orderId, from, to, actorId: actor.userId, actorRole: actor.role, reason } });
  await appendAudit(
    { userId: actor.userId, role: actor.role, entrance: "order.transition", operation: "update", target: `order:${orderId}`, result: "info", ip: actor.ip, detail: { from, to, reason } },
    tx,
  );
}
