import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { loadEnv } from "../env";
import { distanceKm } from "../domain/geo";
import { cancelDeadline, createRun, deliver, openDispute, previewRun, receiveByRunner, registerReceipt, withdrawRun } from "../domain/orders";
import { startOfMonth } from "../domain/time";
import { earnedTitles } from "../domain/titles";
import { badRequest } from "../lib/errors";
import { signedReceiptUrl } from "../lib/storage";
import { gateway } from "../payments";
import { resolveForShop, resolveSettings } from "../settings/service";
import { endpoint, type Ctx } from "../gate/types";

const id = z.string().min(1).max(40);
const actorOf = (ctx: Ctx) => ({ userId: ctx.userId, role: "runner" as const, ip: ctx.ip });

const receiptSchema = z.object({
  orders: z
    .array(
      z.object({
        orderId: id,
        items: z.array(
          z.object({
            itemId: id,
            actualUnitPriceJpy: z.number().int().min(0).max(100_000),
            actualQty: z.number().int().min(0).max(100),
            outOfStock: z.boolean(),
            substitutionName: z.string().trim().max(60).nullish(),
          }),
        ),
      }),
    )
    .min(1)
    .max(20),
});

export const runnerEndpoints = [
  endpoint({
    id: "api.runner.onboarding.start",
    async handler(ctx) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const gw = gateway();
      let accountId = u.stripeAccountId;
      if (!accountId) {
        accountId = await gw.createConnectedAccount({ id: u.id, email: u.email }, `connect-account:${u.id}`);
        await prisma.user.update({ where: { id: u.id }, data: { stripeAccountId: accountId } });
      }
      const app = loadEnv().appUrl;
      const url = await gw.onboardingLink(accountId, `${app}/runner/onboarding?done=1`, `${app}/runner/onboarding`);
      const payoutsEnabled = await gw.payoutsEnabled(accountId);
      await prisma.user.update({ where: { id: u.id }, data: { payoutsEnabled } });
      return { url, payoutsEnabled };
    },
  }),

  endpoint({
    id: "api.runner.onboarding.sync",
    async handler(ctx) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const payoutsEnabled = u.stripeAccountId ? await gateway().payoutsEnabled(u.stripeAccountId) : false;
      await prisma.user.update({ where: { id: u.id }, data: { payoutsEnabled } });
      return { payoutsEnabled };
    },
  }),

  endpoint({
    id: "api.runner.orders.nearby",
    input: z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }),
    async handler(ctx) {
      const me = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const lat = ctx.input.lat ?? me.lat;
      const lng = ctx.input.lng ?? me.lng;
      if (lat == null || lng == null) throw badRequest("現在地がわかりません");
      const global = await resolveSettings();
      const shops = await prisma.shop.findMany({ where: { active: true }, include: { perks: { where: { active: true } } } });
      const out = [];
      for (const shop of shops) {
        const s = await resolveForShop(shop.id);
        const d = distanceKm(shop, { lat, lng });
        if (d > s.service_radius_km) continue;
        const orders = await prisma.order.findMany({
          where: { AND: [ctx.where as Prisma.OrderWhereInput, { shopId: shop.id, expiresAt: { gt: new Date() } }] },
          include: { items: true, customer: { select: { displayName: true } } },
          orderBy: { createdAt: "asc" },
        });
        if (orders.length === 0) continue;
        out.push({
          id: shop.id, name: shop.name, distanceKm: d, perks: shop.perks,
          orders: orders.map((o) => ({ ...o, customerDisplayName: o.customer.displayName })),
        });
      }
      return {
        shops: out,
        limits: { advanceLimitJpy: global.runner_advance_limit_jpy, maxOrdersPerRun: global.max_orders_per_run },
        payoutsEnabled: me.payoutsEnabled,
      };
    },
  }),

  endpoint({
    id: "api.runner.runs.preview",
    input: z.object({ orderIds: z.array(id).min(1).max(20) }),
    async handler(ctx) {
      return previewRun(ctx.input.orderIds, ctx.where, ctx.userId);
    },
  }),

  endpoint({
    id: "api.runner.runs.create",
    input: z.object({ orderIds: z.array(id).min(1).max(20) }),
    async handler(ctx) {
      return createRun(ctx.input.orderIds, ctx.where, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.runner.runs.list",
    async handler(ctx) {
      const runs = await prisma.run.findMany({ where: ctx.where as Prisma.RunWhereInput, include: { shop: true, orders: true }, orderBy: { createdAt: "desc" }, take: 50 });
      return runs.map((r) => ({ id: r.id, status: r.status, shopName: r.shop.name, orderCount: r.orders.length, rewardJpy: r.rewardJpy, createdAt: r.createdAt }));
    },
  }),

  endpoint({
    id: "api.runner.runs.show",
    async handler(ctx) {
      const run = await prisma.run.findUniqueOrThrow({
        where: { id: ctx.params.id },
        include: {
          shop: { include: { perks: { where: { active: true } } } },
          orders: { include: { items: true, customer: { select: { displayName: true, phone: true, address: true } } }, orderBy: { createdAt: "asc" } },
          receipts: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      });
      const s = await resolveForShop(run.shopId);
      const matched = run.orders.filter((o) => o.status === "matched");
      const deadlines = matched.map((o) => cancelDeadline(o)!.getTime());
      const withdrawDeadlineAt = deadlines.length ? new Date(Math.min(...deadlines)) : null;
      return {
        ...run,
        shop: run.shop,
        perks: run.shop.perks,
        receiptUrl: run.receipts[0] ? signedReceiptUrl(run.receipts[0].id, s.receipt_url_ttl_seconds) : null,
        withdrawDeadlineAt,
        canWithdraw: run.status === "shopping" && withdrawDeadlineAt != null && new Date() <= withdrawDeadlineAt,
        // 電話番号・住所は、門番が「配達中（purchased）の注文」のときだけ通す
        orders: run.orders,
      };
    },
  }),

  endpoint({
    id: "api.runner.runs.withdraw",
    async handler(ctx) {
      return withdrawRun(ctx.params.id, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.runner.runs.receipt",
    body: "multipart",
    input: receiptSchema,
    async handler(ctx) {
      const file = ctx.form?.get("receipt");
      if (!file || typeof file === "string") throw badRequest("レシート画像を選んでください");
      const buf = Buffer.from(await file.arrayBuffer());
      return registerReceipt(ctx.params.id, buf, ctx.input, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.runner.orders.deliver",
    async handler(ctx) {
      return deliver(ctx.params.id, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.runner.orders.receive",
    input: z.object({ code: z.string().regex(/^\d{6}$/, "6桁の数字です") }),
    async handler(ctx) {
      return receiveByRunner(ctx.params.id, ctx.input.code, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.runner.orders.dispute",
    input: z.object({ reason: z.string().trim().min(1).max(500) }),
    async handler(ctx) {
      return openDispute(ctx.params.id, ctx.input.reason, actorOf(ctx));
    },
  }),

  endpoint({
    id: "api.runner.earnings",
    async handler(ctx) {
      const s = await resolveSettings();
      const [payouts, ratings, totalRuns, monthlyRuns] = await Promise.all([
        prisma.payout.findMany({ where: { runnerId: ctx.userId }, orderBy: { createdAt: "desc" }, take: 100 }),
        prisma.rating.findMany({ where: { runnerId: ctx.userId }, orderBy: { createdAt: "desc" } }),
        prisma.run.count({ where: { runnerId: ctx.userId, status: "done" } }),
        prisma.run.count({ where: { runnerId: ctx.userId, status: "done", createdAt: { gte: startOfMonth(new Date(), s.timezone) } } }),
      ]);
      const avgRating = ratings.length ? Math.round((ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) * 10) / 10 : null;
      const sum = (st: string) => payouts.filter((p) => p.status === st).reduce((a, p) => a + p.amountJpy, 0);
      return {
        totals: { paidJpy: sum("paid"), scheduledJpy: sum("scheduled"), runs: totalRuns },
        monthlyRuns, avgRating, ratingCount: ratings.length,
        titles: earnedTitles(s.title_rules, { monthlyRuns, totalRuns, avgRating }),
        payouts,
        messages: ratings.slice(0, 30).map((r) => ({ stars: r.stars, message: r.message, at: r.createdAt })),
      };
    },
  }),
];
