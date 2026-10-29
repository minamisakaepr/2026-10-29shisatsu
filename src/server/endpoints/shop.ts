import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { zonedDate } from "../domain/time";
import { forbidden } from "../lib/errors";
import { resolveSettings } from "../settings/service";
import { shopIdsOf } from "../gate/scopes";
import { endpoint, RawResponse, type Ctx } from "../gate/types";

const id = z.string().min(1).max(40);

async function assertMyShop(ctx: Ctx, shopId: string) {
  if (!(await shopIdsOf(ctx.userId)).includes(shopId)) throw forbidden("自分の店ではありません");
}

/** 自店の注文集計（個人を特定できる情報は含めない） */
async function stats(ctx: Ctx<{ month?: string }>) {
  const s = await resolveSettings();
  const month = ctx.input.month ?? zonedDate(new Date(), s.timezone).slice(0, 7);
  const shops = await prisma.shop.findMany({ where: { id: { in: await shopIdsOf(ctx.userId) } } });
  const out = [];
  for (const shop of shops) {
    const orders = await prisma.order.findMany({
      where: { AND: [ctx.where as Prisma.OrderWhereInput, { shopId: shop.id, status: "completed" }] },
      select: { completedAt: true, actualItemsJpy: true, items: { select: { name: true, actualQty: true } } },
    });
    const days = new Map<string, { date: string; orders: number; itemsJpy: number }>();
    const products = new Map<string, number>();
    for (const o of orders) {
      const date = zonedDate(o.completedAt!, s.timezone);
      if (!date.startsWith(month)) continue;
      const d = days.get(date) ?? { date, orders: 0, itemsJpy: 0 };
      d.orders++;
      d.itemsJpy += o.actualItemsJpy ?? 0;
      days.set(date, d);
      for (const i of o.items) products.set(i.name, (products.get(i.name) ?? 0) + (i.actualQty ?? 0));
    }
    out.push({
      id: shop.id, name: shop.name,
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
      products: [...products.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty),
    });
  }
  return { month, shops: out };
}

const monthInput = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

// CSV の値に「=」などで始まる文字があると表計算ソフトで式として動くため、先頭に ' を付ける
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const shopEndpoints = [
  endpoint({
    id: "api.shop.products.list",
    async handler(ctx) {
      return prisma.product.findMany({ where: ctx.where as Prisma.ProductWhereInput, orderBy: [{ shopId: "asc" }, { sortOrder: "asc" }] });
    },
  }),
  endpoint({
    id: "api.shop.products.create",
    input: z.object({ shopId: id, name: z.string().trim().min(1).max(40), priceJpy: z.number().int().min(1).max(100_000), sortOrder: z.number().int().min(0).max(999).default(0) }),
    async handler(ctx) {
      await assertMyShop(ctx, ctx.input.shopId);
      return prisma.product.create({ data: ctx.input, select: { id: true } });
    },
  }),
  endpoint({
    id: "api.shop.products.update",
    input: z.object({ name: z.string().trim().min(1).max(40).optional(), priceJpy: z.number().int().min(1).max(100_000).optional(), active: z.boolean().optional(), sortOrder: z.number().int().min(0).max(999).optional() }),
    async handler(ctx) {
      // 価格を変えても、すでにある注文は注文時点の価格のまま（OrderItem にコピー済み）
      return prisma.product.update({ where: { id: ctx.params.id }, data: ctx.input, select: { id: true } });
    },
  }),
  endpoint({
    id: "api.shop.perks.list",
    async handler(ctx) {
      return prisma.runnerPerk.findMany({ where: ctx.where as Prisma.RunnerPerkWhereInput });
    },
  }),
  endpoint({
    id: "api.shop.perks.create",
    input: z.object({ shopId: id, title: z.string().trim().min(1).max(40), description: z.string().max(200).default("") }),
    async handler(ctx) {
      await assertMyShop(ctx, ctx.input.shopId);
      return prisma.runnerPerk.create({ data: ctx.input, select: { id: true } });
    },
  }),
  endpoint({
    id: "api.shop.perks.update",
    input: z.object({ title: z.string().trim().min(1).max(40).optional(), description: z.string().max(200).optional(), active: z.boolean().optional() }),
    async handler(ctx) {
      return prisma.runnerPerk.update({ where: { id: ctx.params.id }, data: ctx.input, select: { id: true } });
    },
  }),
  endpoint({
    id: "api.shop.stats",
    input: monthInput,
    handler: stats,
  }),
  endpoint({
    id: "export.shop.stats_csv",
    input: monthInput,
    async handler(ctx) {
      const r = await stats(ctx);
      const rows = [["店", "日付", "注文数", "商品額(円)"]];
      for (const s of r.shops) for (const d of s.days) rows.push([s.name, d.date, String(d.orders), String(d.itemsJpy)]);
      const body = "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
      return new RawResponse(
        new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="shop-stats-${r.month}.csv"`, "cache-control": "no-store" } }),
      );
    },
  }),
];

export { csvCell };
