// モック決済（偽物の Stripe）。PAYMENT_MODE=mock のときに使う。
// 本物の Stripe と同じく「冪等キー」「手動キャプチャ」「残額の自動解放」「送金」を再現し、
// 記録は MockStripeObject テーブル（＝Stripe 側の記録の代わり）に持つ。照合処理の相手にもなる。
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { hmac, randomToken, safeEqual } from "../lib/crypto";
import type { GatewayEvent, IntentInfo, PaymentGateway, TransferInfo } from "./gateway";

interface MockIntent {
  amount: number;
  status: IntentInfo["status"];
  captured: number;
  refunded: number;
  chargeId: string | null;
  orderId: string;
}

async function getObj<T>(id: string): Promise<T> {
  const o = await prisma.mockStripeObject.findUnique({ where: { id } });
  if (!o) throw new Error(`モック: ${id} がありません`);
  return o.data as T;
}

async function putObj(id: string, type: string, data: object) {
  await prisma.mockStripeObject.upsert({
    where: { id },
    create: { id, type, data: data as Prisma.InputJsonValue },
    update: { data: data as Prisma.InputJsonValue },
  });
}

/**
 * 冪等キーが同じなら、前回の結果をそのまま返す（本物の Stripe と同じふるまい）。
 * 同じキーの呼び出しが同時に来ても、キーごとのロックで1つずつ処理する
 * （ロックがないと、2つ目が「もうキャプチャ済み」でエラーになる）。
 */
async function idem<T extends object>(key: string, fn: () => Promise<T>): Promise<T> {
  const id = `idem:${key}`;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const prev = await tx.mockStripeObject.findUnique({ where: { id } });
      if (prev) return prev.data as T;
      const result = await fn();
      await putObj(id, "idem", result);
      return result;
    },
    { timeout: 15_000 },
  );
}

const info = (id: string, i: MockIntent): IntentInfo => ({
  id, status: i.status, amountAuthorizedJpy: i.amount, amountCapturedJpy: i.captured, amountRefundedJpy: i.refunded, chargeId: i.chargeId,
});

export function createMockGateway(secret: string): PaymentGateway {
  return {
    mode: "mock",
    publishableKey: null,

    async createAuthorization({ amountJpy, orderId, idempotencyKey }) {
      return idem(idempotencyKey, async () => {
        const id = `mock_pi_${randomToken(12)}`;
        await putObj(id, "payment_intent", { amount: amountJpy, status: "requires_confirmation", captured: 0, refunded: 0, chargeId: null, orderId } satisfies MockIntent);
        return { intentId: id, clientSecret: `${id}_secret_${randomToken(8)}`, stripeCustomerId: null };
      });
    },

    async mockConfirm(intentId) {
      const i = await getObj<MockIntent>(intentId);
      if (i.status === "requires_confirmation") {
        await putObj(intentId, "payment_intent", { ...i, status: "authorized", chargeId: `mock_ch_${randomToken(12)}` });
      }
    },

    async retrieveIntent(intentId) {
      return info(intentId, await getObj<MockIntent>(intentId));
    },

    async capture(intentId, amountJpy, idempotencyKey) {
      return idem(idempotencyKey, async () => {
        const i = await getObj<MockIntent>(intentId);
        if (i.status !== "authorized") throw new Error(`モック: キャプチャできない状態です (${i.status})`);
        if (amountJpy > i.amount) throw new Error("モック: 仮押さえ額を超えてキャプチャはできません");
        const next = { ...i, status: "captured" as const, captured: amountJpy };
        await putObj(intentId, "payment_intent", next);
        return info(intentId, next);
      });
    },

    async cancel(intentId, idempotencyKey) {
      return idem(idempotencyKey, async () => {
        const i = await getObj<MockIntent>(intentId);
        if (i.status === "captured") throw new Error("モック: キャプチャ済みは取り消せません");
        const next = { ...i, status: "canceled" as const };
        await putObj(intentId, "payment_intent", next);
        return info(intentId, next);
      });
    },

    async refund(intentId, amountJpy, idempotencyKey) {
      return idem(idempotencyKey, async () => {
        const i = await getObj<MockIntent>(intentId);
        if (i.status !== "captured" || i.refunded + amountJpy > i.captured) throw new Error("モック: 返金できません");
        await putObj(intentId, "payment_intent", { ...i, refunded: i.refunded + amountJpy });
        return { refundId: `mock_re_${randomToken(12)}` };
      });
    },

    async createConnectedAccount(_u, idempotencyKey) {
      const r = await idem(idempotencyKey, async () => {
        const id = `mock_acct_${randomToken(12)}`;
        await putObj(id, "account", { payoutsEnabled: true });
        return { id };
      });
      return r.id;
    },

    async onboardingLink() {
      return null; // モックでは口座登録の画面はなく、すぐに登録済みになる
    },

    async payoutsEnabled(accountId) {
      return (await getObj<{ payoutsEnabled: boolean }>(accountId)).payoutsEnabled;
    },

    async transfer({ amountJpy, destination, sourceChargeId, idempotencyKey }) {
      return idem(idempotencyKey, async () => {
        const id = `mock_tr_${randomToken(12)}`;
        const t: TransferInfo = { id, amountJpy, destination, reversed: false };
        await putObj(id, "transfer", { ...t, sourceChargeId });
        return t;
      });
    },

    async retrieveTransfer(transferId) {
      return getObj<TransferInfo>(transferId);
    },

    parseWebhook(rawBody, signature): GatewayEvent {
      // モックの Webhook は、APP_SECRET による署名で検証する（テスト用）
      const expected = hmac(secret, rawBody);
      if (!signature || !safeEqual(signature, expected)) throw new Error("署名が正しくありません");
      return JSON.parse(rawBody) as GatewayEvent;
    },
  };
}
