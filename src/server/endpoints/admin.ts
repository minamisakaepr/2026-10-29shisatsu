import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { resolveDispute } from "../domain/orders";
import { badRequest } from "../lib/errors";
import { signedReceiptUrl } from "../lib/storage";
import { balances } from "../money/ledger";
import { refundOrder } from "../payments/service";
import { deleteOverride, resolveSettings, revertChange, setOverride, updateGlobal } from "../settings/service";
import { verifyAuditChain } from "../gate/audit";
import { jobIds, runJob } from "../gate/jobs";
import { getLedger, ROLES } from "../gate/ledger";
import { endpoint, RawResponse, type Ctx } from "../gate/types";
import { csvCell } from "./shop";

const actorOf = (ctx: Ctx) => ({ userId: ctx.userId, role: "admin" as const, ip: ctx.ip });
const reason = z.string().max(500);
const jsonValue = z.union([z.number(), z.string(), z.boolean(), z.record(z.string(), z.unknown())]);

export const adminEndpoints = [
  // ---- 設定値 ----
  endpoint({
    id: "api.admin.settings.list",
    async handler() {
      const [settings, overrides, shops, areas] = await Promise.all([
        prisma.setting.findMany({ orderBy: { key: "asc" } }),
        prisma.settingOverride.findMany(),
        prisma.shop.findMany({ select: { id: true, name: true } }),
        prisma.area.findMany({ select: { id: true, name: true } }),
      ]);
      const nameOf = (t: string, id: string) => (t === "shop" ? shops : areas).find((x) => x.id === id)?.name ?? id;
      return settings.map((s) => ({
        ...s,
        overrides: overrides.filter((o) => o.key === s.key).map((o) => ({ ...o, scopeName: nameOf(o.scopeType, o.scopeId) })),
      }));
    },
  }),
  endpoint({
    id: "api.admin.settings.update",
    input: z.object({ value: jsonValue, reason }),
    async handler(ctx) {
      const ch = await updateGlobal(ctx.params.key, ctx.input.value, ctx.reason!, actorOf(ctx));
      return { changeId: ch.id };
    },
  }),
  endpoint({
    id: "api.admin.settings.override_set",
    input: z.object({ scopeType: z.enum(["area", "shop"]), scopeId: z.string().min(1).max(40), value: jsonValue, reason }),
    async handler(ctx) {
      const ch = await setOverride(ctx.params.key, ctx.input.scopeType, ctx.input.scopeId, ctx.input.value, ctx.reason!, actorOf(ctx));
      return { changeId: ch.id };
    },
  }),
  endpoint({
    id: "api.admin.settings.override_delete",
    input: z.object({ reason }),
    async handler(ctx) {
      const ch = await deleteOverride(ctx.params.key, ctx.params.overrideId, ctx.reason!, actorOf(ctx));
      return { changeId: ch.id };
    },
  }),
  endpoint({
    id: "api.admin.settings.history",
    input: z.object({ key: z.string().max(60).optional() }),
    async handler(ctx) {
      return prisma.settingChange.findMany({ where: ctx.input.key ? { key: ctx.input.key } : {}, orderBy: { createdAt: "desc" }, take: 200 });
    },
  }),
  endpoint({
    id: "api.admin.settings.revert",
    input: z.object({ reason }),
    async handler(ctx) {
      const ch = await revertChange(ctx.params.changeId, ctx.reason!, actorOf(ctx));
      return { changeId: ch.id };
    },
  }),
  endpoint({
    id: "api.admin.areas",
    async handler() {
      return prisma.area.findMany({ include: { shops: { select: { id: true, name: true } } } });
    },
  }),

  // ---- アクセス台帳・通行記録 ----
  endpoint({
    id: "api.admin.ledger.show",
    async handler() {
      // 全ロール × 全出入り口の表。台帳にない組み合わせは「拒否」
      const roles = ROLES;
      return {
        roles,
        rows: getLedger().entrances.map((e) => ({
          id: e.id, kind: e.kind, method: e.method ?? null, path: e.path ?? null, resource: e.resource ?? null,
          requireReason: Boolean(e.require_reason),
          cells: Object.fromEntries(roles.map((r) => {
            const g = e.grants.find((x) => x.role === r);
            return [r, g ? { ops: g.ops, scope: g.scope, fields: g.fields ?? [], reason: g.reason } : null];
          })),
        })),
      };
    },
  }),
  endpoint({
    id: "api.admin.audit.search",
    input: z.object({
      userId: z.string().max(40).optional(), entrance: z.string().max(80).optional(), result: z.enum(["allow", "deny", "error", "info"]).optional(),
      ip: z.string().max(60).optional(), target: z.string().max(80).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    async handler(ctx) {
      const q = ctx.input;
      const where: Prisma.AuditLedgerWhereInput = {
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.entrance ? { entrance: { contains: q.entrance } } : {}),
        ...(q.result ? { result: q.result } : {}),
        ...(q.ip ? { ip: q.ip } : {}),
        ...(q.target ? { target: { contains: q.target } } : {}),
        ...(q.from || q.to ? { at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      };
      return prisma.auditLedger.findMany({ where, orderBy: { seq: "desc" }, take: q.limit });
    },
  }),
  endpoint({
    id: "api.admin.audit.verify",
    async handler() {
      return { audit: await verifyAuditChain() };
    },
  }),
  endpoint({
    id: "api.admin.audit.anomalies",
    async handler() {
      const s = await resolveSettings();
      const since = new Date(Date.now() - s.anomaly_window_minutes * 60_000);
      const [byUser, byIp] = await Promise.all([
        prisma.auditLedger.groupBy({ by: ["userId"], where: { result: "deny", at: { gte: since } }, _count: { _all: true } }),
        prisma.auditLedger.groupBy({ by: ["ip"], where: { result: "deny", at: { gte: since } }, _count: { _all: true } }),
      ]);
      return {
        windowMinutes: s.anomaly_window_minutes,
        threshold: s.anomaly_deny_threshold,
        users: byUser.filter((r) => r._count._all >= s.anomaly_deny_threshold).map((r) => ({ userId: r.userId, denies: r._count._all })),
        ips: byIp.filter((r) => r._count._all >= s.anomaly_deny_threshold).map((r) => ({ ip: r.ip, denies: r._count._all })),
      };
    },
  }),

  // ---- お金の台帳 ----
  endpoint({
    id: "api.admin.money.journals",
    input: z.object({ orderId: z.string().max(40).optional() }),
    async handler(ctx) {
      const journals = await prisma.moneyJournal.findMany({
        where: ctx.input.orderId ? { orderId: ctx.input.orderId } : {},
        include: { lines: true },
        orderBy: { seq: "desc" },
        take: 200,
      });
      return { balances: await balances(), journals };
    },
  }),
  endpoint({
    id: "api.admin.money.reconciliations",
    async handler() {
      return prisma.reconciliationRun.findMany({ orderBy: { at: "desc" }, take: 30 });
    },
  }),
  endpoint({
    id: "export.admin.money_csv",
    async handler() {
      const journals = await prisma.moneyJournal.findMany({ include: { lines: true }, orderBy: { seq: "asc" } });
      const rows = [["seq", "日時", "イベント", "注文", "勘定科目", "借方(円)", "貸方(円)", "Stripe参照", "冪等キー"]];
      for (const j of journals) {
        for (const l of j.lines) {
          rows.push([j.seq.toString(), j.createdAt.toISOString(), j.eventType, j.orderId ?? "", l.account, String(l.debitJpy), String(l.creditJpy), j.stripeRef ?? "", j.idempotencyKey]);
        }
      }
      const body = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
      return new RawResponse(new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="money-ledger.csv"', "cache-control": "no-store" } }));
    },
  }),
  endpoint({
    id: "api.admin.notifications",
    async handler() {
      return prisma.notification.findMany({ where: { audience: "admin" }, orderBy: { createdAt: "desc" }, take: 100 });
    },
  }),

  // ---- 注文・トラブル対応 ----
  endpoint({
    id: "api.admin.orders.list",
    input: z.object({ status: z.enum(["draft", "placed", "matched", "purchased", "delivered", "completed", "cancelled", "disputed", "expired"]).optional() }),
    async handler(ctx) {
      const orders = await prisma.order.findMany({
        where: ctx.input.status ? { status: ctx.input.status } : {},
        include: { shop: true, run: true, payments: { where: { active: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return orders.map((o) => ({ ...o, shopName: o.shop.name, runnerId: o.run?.runnerId ?? null, paymentStatus: o.payments[0]?.status ?? null }));
    },
  }),
  endpoint({
    id: "api.admin.orders.show",
    async handler(ctx) {
      const o = await prisma.order.findUniqueOrThrow({
        where: { id: ctx.params.id },
        include: { shop: true, items: true, transitions: { orderBy: { at: "asc" } }, payments: true, payout: true, disputes: true, run: { include: { receipts: { orderBy: { createdAt: "desc" }, take: 1 } } } },
      });
      const s = await resolveSettings();
      const receipt = o.run?.receipts[0];
      return { ...o, shopName: o.shop.name, runnerId: o.run?.runnerId ?? null, receiptUrl: receipt ? signedReceiptUrl(receipt.id, s.receipt_url_ttl_seconds) : null };
    },
  }),
  endpoint({
    id: "api.admin.users.pii",
    async handler(ctx) {
      // 理由の入力は門番が確認し、通行記録に残している
      return prisma.user.findUniqueOrThrow({ where: { id: ctx.params.id }, select: { id: true, email: true, displayName: true, phone: true, address: true } });
    },
  }),
  endpoint({
    id: "api.admin.disputes.list",
    async handler() {
      return prisma.dispute.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    },
  }),
  endpoint({
    id: "api.admin.disputes.resolve",
    input: z.object({ resolution: z.enum(["complete", "cancel"]), reason }),
    async handler(ctx) {
      return resolveDispute(ctx.params.id, ctx.input.resolution, ctx.reason!, actorOf(ctx));
    },
  }),
  endpoint({
    id: "api.admin.orders.refund",
    input: z.object({ reason }),
    async handler(ctx) {
      const refundedJpy = await refundOrder(ctx.params.id, actorOf(ctx), ctx.reason!);
      return { id: ctx.params.id, refundedJpy };
    },
  }),
  endpoint({
    id: "api.admin.jobs.run",
    async handler(ctx) {
      const name = `job.${ctx.params.name}`;
      if (!jobIds().includes(name)) throw badRequest(`定期処理 ${ctx.params.name} はありません`);
      return { job: name, result: await runJob(name, ctx.userId) };
    },
  }),
];
