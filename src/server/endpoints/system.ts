// Webhook とファイル（レシート画像）
import { z } from "zod";
import { prisma } from "../db";
import { AppError, notFound } from "../lib/errors";
import { readReceipt, verifyReceiptSignature } from "../lib/storage";
import { gateway } from "../payments";
import { onAuthorized } from "../payments/service";
import { endpoint, RawResponse } from "../gate/types";

export const systemEndpoints = [
  endpoint({
    id: "webhook.stripe",
    body: "raw",
    async handler(ctx) {
      const gw = gateway();
      const sig = ctx.req.headers.get(gw.mode === "stripe" ? "stripe-signature" : "x-mock-signature");
      let ev;
      try {
        ev = gw.parseWebhook(ctx.rawBody ?? "", sig);
      } catch {
        throw new AppError(400, "bad_signature", "署名を確認できません");
      }
      // 同じイベントは1回だけ処理する（Stripe は同じイベントを再送することがある）
      const seen = await prisma.webhookEvent.findUnique({ where: { id: ev.id } });
      if (seen?.processedAt) return { received: true };
      if (!seen) await prisma.webhookEvent.create({ data: { id: ev.id, type: ev.type } });

      if (ev.type === "authorized" && ev.intentId) {
        const p = await prisma.payment.findUnique({ where: { intentId: ev.intentId } });
        if (p) await onAuthorized(p.id);
      } else if (ev.type === "failed" && ev.intentId) {
        await prisma.payment.updateMany({ where: { intentId: ev.intentId, status: "requires_confirmation" }, data: { status: "failed" } });
      } else if (ev.type === "account_updated" && ev.accountId) {
        const u = await prisma.user.findFirst({ where: { stripeAccountId: ev.accountId } });
        if (u) await prisma.user.update({ where: { id: u.id }, data: { payoutsEnabled: await gw.payoutsEnabled(ev.accountId) } });
      }
      await prisma.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: new Date() } });
      return { received: true };
    },
  }),

  endpoint({
    id: "file.receipt",
    input: z.object({ exp: z.string().max(20), sig: z.string().max(100) }),
    async handler(ctx) {
      // ログイン・データ範囲（門番が確認済み）に加えて、期限付き URL の署名と期限も確かめる
      if (!verifyReceiptSignature(ctx.params.id, ctx.input.exp, ctx.input.sig)) {
        throw new AppError(403, "url_expired", "URL の期限が切れています。画面を読み込み直してください");
      }
      const r = await prisma.receipt.findUnique({ where: { id: ctx.params.id } });
      if (!r) throw notFound();
      const buf = await readReceipt(r.storageKey);
      return new RawResponse(
        new Response(new Uint8Array(buf), {
          headers: {
            "content-type": r.mime,
            "cache-control": "private, no-store",
            "content-disposition": "inline",
            "x-content-type-options": "nosniff",
          },
        }),
      );
    },
  }),
];
