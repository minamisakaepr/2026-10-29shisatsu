// データ範囲（scope）を、データベースの検索条件に変換する。権限の判断はここ1か所に集める。
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { forbidden, notFound } from "../lib/errors";
import type { Resource, Scope } from "./ledger";
import type { Principal } from "./session";

export async function shopIdsOf(userId: string): Promise<string[]> {
  const rows = await prisma.shopMember.findMany({ where: { userId }, select: { shopId: true } });
  return rows.map((r) => r.shopId);
}

/** resource × scope × ユーザー から where 条件を作る。対応していない組み合わせは拒否 */
export async function scopeWhere(resource: Resource, scope: Scope, p: Principal): Promise<Record<string, unknown>> {
  if (scope === "all") {
    if (!p.roles.includes("admin") && !p.roles.includes("system")) throw forbidden();
    return {};
  }
  const uid = p.userId;
  if (!uid) throw forbidden();
  switch (resource) {
    case "order": {
      if (scope === "own") return { customerId: uid } satisfies Prisma.OrderWhereInput;
      if (scope === "assigned") return { run: { runnerId: uid } } satisfies Prisma.OrderWhereInput;
      if (scope === "shop") return { shopId: { in: await shopIdsOf(uid) } } satisfies Prisma.OrderWhereInput;
      // 自分の注文は「近くの注文」に出さない（自分で自分の注文を引き受けられないようにする）
      if (scope === "nearby") return { status: "placed", customerId: { not: uid } } satisfies Prisma.OrderWhereInput;
      break;
    }
    case "run":
      if (scope === "assigned") return { runnerId: uid } satisfies Prisma.RunWhereInput;
      break;
    case "shop":
      if (scope === "catalog") return { active: true } satisfies Prisma.ShopWhereInput;
      if (scope === "shop") return { id: { in: await shopIdsOf(uid) } } satisfies Prisma.ShopWhereInput;
      break;
    case "product":
    case "perk":
      if (scope === "catalog") return { active: true, shop: { active: true } };
      if (scope === "shop") return { shopId: { in: await shopIdsOf(uid) } };
      break;
    case "receipt":
      if (scope === "own") return { run: { orders: { some: { customerId: uid } } } } satisfies Prisma.ReceiptWhereInput;
      if (scope === "assigned") return { run: { runnerId: uid } } satisfies Prisma.ReceiptWhereInput;
      break;
    case "user":
      if (scope === "self") return { id: uid } satisfies Prisma.UserWhereInput;
      break;
    default:
      break;
  }
  throw forbidden(`データ範囲 ${resource}/${scope} は使えません`);
}

/** :id で指定されたものが、範囲の中にあるか確かめる。範囲外は「見つかりません」（存在も教えない） */
export async function assertInScope(resource: Resource, id: string, where: Record<string, unknown>): Promise<void> {
  const w = { id, ...where };
  let found: unknown;
  switch (resource) {
    case "order": found = await prisma.order.findFirst({ where: w, select: { id: true } }); break;
    case "run": found = await prisma.run.findFirst({ where: w, select: { id: true } }); break;
    case "shop": found = await prisma.shop.findFirst({ where: w, select: { id: true } }); break;
    case "product": found = await prisma.product.findFirst({ where: w, select: { id: true } }); break;
    case "perk": found = await prisma.runnerPerk.findFirst({ where: w, select: { id: true } }); break;
    case "receipt": found = await prisma.receipt.findFirst({ where: w, select: { id: true } }); break;
    case "user": found = await prisma.user.findFirst({ where: w, select: { id: true } }); break;
    case "dispute": found = await prisma.dispute.findFirst({ where: w, select: { id: true } }); break;
    case "setting": found = true; break;
  }
  if (!found) throw notFound();
}
