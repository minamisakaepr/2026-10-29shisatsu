import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { distanceKm } from "../domain/geo";
import { approveByCustomer, autoCompleteAt, cancelByCustomer, cancelDeadline, confirmPayment, createOrder, openDispute, rateRunner, receiveByCustomer, snapshotOf } from "../domain/orders";
import { inTimeRange } from "../domain/time";
import { estimateOrder } from "../domain/pricing";
import { signedReceiptUrl } from "../lib/storage";
import { gateway } from "../payments";
import { resolveForShop } from "../settings/service";
import { endpoint, type Ctx } from "../gate/types";

const id = z.string().min(1).max(40);
const actorOf = (ctx: Ctx) => ({ userId: ctx.userId, role: "customer" as const, ip: ctx.ip });

async function myLocation(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { lat: true, lng: true } });
  return u.lat != null && u.lng != null ? { lat: u.lat, lng: u.lng } : null;
}

export const customerEndpoints = [
  endpoint({
    id: "api.customer.shops.list",
    async handler(ctx) {
      const shops = await prisma.shop.findMany({ where: ctx.where as Prisma.ShopWhereInput, include: { area: true }, orderBy: { name: "asc" } });
      const loc = await myLocation(ctx.userId);
      return Promise.all(
        shops.map(async (s) => {
          const settings = await resolveForShop(s.id);
          const d = loc ? distanceKm(s, loc) : null;
          return { id: s.id, name: s.name, address: s.address, areaName: s.area.name, distanceKm: d, inArea: d != null && d <= settings.service_radius_km };
        }),
      );
    },
  }),

  endpoint({
    id: "api.customer.shops.show",
    async handler(ctx) {
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: ctx.params.id } });
      const products = await prisma.product.findMany({ where: { shopId: shop.id, active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
      const s = await resolveForShop(shop.id);
      const loc = await myLocation(ctx.userId);
      const d = loc ? distanceKm(shop, loc) : 0;
      const est = estimateOrder(s, [], { isRain: s.rain_active, isEarly: inTimeRange(new Date(), s.early_hours, s.timezone), distanceKm: d });
      return {
        id: shop.id, name: shop.name, address: shop.address, products, maxItemsPerOrder: s.max_items_per_order,
        estimate: { deliveryFeeJpy: est.deliveryFeeJpy, platformFeeRate: s.platform_fee_rate, holdBufferRate: s.hold_buffer_rate, distanceKm: d, inArea: d <= s.service_radius_km },
      };
    },
  }),

  endpoint({
    id: "api.customer.orders.create",
    input: z.object({
      shopId: id,
      items: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(100) })).min(1).max(50),
      dropoffLabel: z.string().trim().min(1).max(60),
      dropoffLat: z.number().min(-90).max(90).optional(),
      dropoffLng: z.number().min(-180).max(180).optional(),
      note: z.string().max(200).optional(),
    }),
    async handler(ctx) {
      const { order, auth } = await createOrder(actorOf(ctx), ctx.input);
      return {
        id: order.id, status: order.status, estimatedTotalJpy: order.estimatedTotalJpy, holdAmountJpy: order.holdAmountJpy,
        payment: { mode: auth.mode, clientSecret: auth.clientSecret, publishableKey: auth.publishableKey },
      };
    },
  }),

  endpoint({
    id: "api.customer.orders.confirm",
    async handler(ctx) {
      return confirmPayment(ctx.params.id);
    },
  }),

  endpoint({
    id: "api.customer.orders.list",
    async handler(ctx) {
      const orders = await prisma.order.findMany({
        where: { ...(ctx.where as Prisma.OrderWhereInput), status: { not: "draft" } },
        include: { shop: true, items: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return orders.map((o) => ({
        id: o.id, status: o.status, shopName: o.shop.name, itemCount: o.items.reduce((s, i) => s + i.qty, 0),
        estimatedTotalJpy: o.estimatedTotalJpy, finalTotalJpy: o.finalTotalJpy, approvalStatus: o.approvalStatus, createdAt: o.createdAt,
      }));
    },
  }),

  endpoint({
    id: "api.customer.orders.show",
    async handler(ctx) {
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: ctx.params.id },
        include: {
          shop: true, items: true, rating: true, transitions: { orderBy: { at: "asc" } },
          run: { include: { runner: { include: { ratingsGot: true } }, receipts: { orderBy: { createdAt: "desc" }, take: 1 } } },
        },
      });
      const snap = snapshotOf(o);
      const ratings = o.run?.runner.ratingsGot ?? [];
      const receipt = o.run?.receipts[0];
      const dl = cancelDeadline(o);
      return {
        ...o,
        shop: { id: o.shop.id, name: o.shop.name },
        runner: o.run
          ? {
              displayName: o.run.runner.displayName,
              avgRating: ratings.length ? Math.round((ratings.reduce((s, r) => s + r.stars, 0) / ratings.length) * 10) / 10 : null,
              ratingCount: ratings.length,
            }
          : null,
        receiptUrl: receipt ? signedReceiptUrl(receipt.id, snap.receipt_url_ttl_seconds) : null,
        cancelDeadlineAt: dl,
        autoCompleteAt: autoCompleteAt(o),
        canCancel: o.status === "placed" || (o.status === "matched" && dl != null && new Date() <= dl),
        paymentMode: gateway().mode,
      };
    },
  }),

  endpoint({
    id: "api.customer.orders.cancel",
    async handler(ctx) {
      return cancelByCustomer(ctx.params.id, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.customer.orders.approve",
    input: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(200).default("") }),
    async handler(ctx) {
      const r = await approveByCustomer(ctx.params.id, ctx.input.decision, ctx.input.note, actorOf(ctx));
      return { ...r.order, payment: r.payment ? { mode: r.payment.mode, clientSecret: r.payment.clientSecret, publishableKey: r.payment.publishableKey } : null };
    },
  }),

  endpoint({
    id: "api.customer.orders.receive",
    async handler(ctx) {
      return receiveByCustomer(ctx.params.id, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.customer.orders.dispute",
    input: z.object({ reason: z.string().trim().min(1).max(500) }),
    async handler(ctx) {
      return openDispute(ctx.params.id, ctx.input.reason, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.customer.orders.rate",
    input: z.object({ stars: z.number().int().min(1).max(5), message: z.string().max(300).default("") }),
    async handler(ctx) {
      return rateRunner(ctx.params.id, ctx.input.stars, ctx.input.message, ctx.userId);
    },
  }),
];
