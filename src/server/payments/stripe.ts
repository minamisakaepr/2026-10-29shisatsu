// Stripe（テストモード）。キーは env.ts で sk_test_ / pk_test_ であることを確認済み。
import Stripe from "stripe";
import type { GatewayEvent, IntentInfo, IntentStatus, PaymentGateway, TransferInfo } from "./gateway";

function mapStatus(s: Stripe.PaymentIntent.Status): IntentStatus {
  switch (s) {
    case "requires_capture":
      return "authorized";
    case "succeeded":
      return "captured";
    case "canceled":
      return "canceled";
    default:
      return "requires_confirmation";
  }
}

function toInfo(pi: Stripe.PaymentIntent): IntentInfo {
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const status = mapStatus(pi.status);
  return {
    id: pi.id,
    status,
    amountAuthorizedJpy: pi.amount,
    amountCapturedJpy: status === "captured" ? pi.amount_received : 0,
    amountRefundedJpy: charge?.amount_refunded ?? 0,
    chargeId: typeof pi.latest_charge === "string" ? pi.latest_charge : (charge?.id ?? null),
  };
}

const toTransfer = (t: Stripe.Transfer): TransferInfo => ({
  id: t.id,
  amountJpy: t.amount,
  destination: typeof t.destination === "string" ? t.destination : (t.destination?.id ?? ""),
  reversed: t.reversed,
});

export function createStripeGateway(secretKey: string, publishableKey: string, webhookSecret: string): PaymentGateway {
  const stripe = new Stripe(secretKey);
  return {
    mode: "stripe",
    publishableKey,

    async createAuthorization({ amountJpy, orderId, customer, idempotencyKey }) {
      let stripeCustomerId = customer.stripeCustomerId;
      if (!stripeCustomerId) {
        const c = await stripe.customers.create(
          { email: customer.email, metadata: { userId: customer.id } },
          { idempotencyKey: `customer:${customer.id}` },
        );
        stripeCustomerId = c.id;
      }
      const pi = await stripe.paymentIntents.create(
        {
          amount: amountJpy,
          currency: "jpy", // 円は小数のない通貨なので、金額はそのまま円
          capture_method: "manual", // 与信（仮押さえ）だけ。受け取り時にキャプチャ
          customer: stripeCustomerId,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          transfer_group: orderId,
          metadata: { orderId },
        },
        { idempotencyKey },
      );
      return { intentId: pi.id, clientSecret: pi.client_secret!, stripeCustomerId };
    },

    async retrieveIntent(intentId) {
      return toInfo(await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge"] }));
    },

    async capture(intentId, amountJpy, idempotencyKey) {
      // 実額だけキャプチャ。残りの仮押さえは Stripe が自動で解放する
      await stripe.paymentIntents.capture(intentId, { amount_to_capture: amountJpy }, { idempotencyKey });
      return this.retrieveIntent(intentId);
    },

    async cancel(intentId, idempotencyKey) {
      await stripe.paymentIntents.cancel(intentId, {}, { idempotencyKey });
      return this.retrieveIntent(intentId);
    },

    async refund(intentId, amountJpy, idempotencyKey) {
      const r = await stripe.refunds.create({ payment_intent: intentId, amount: amountJpy }, { idempotencyKey });
      return { refundId: r.id };
    },

    async createConnectedAccount(u, idempotencyKey) {
      const a = await stripe.accounts.create(
        {
          type: "express",
          country: "JP",
          email: u.email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          metadata: { userId: u.id },
        },
        { idempotencyKey },
      );
      return a.id;
    },

    async onboardingLink(accountId, returnUrl, refreshUrl) {
      const link = await stripe.accountLinks.create({ account: accountId, return_url: returnUrl, refresh_url: refreshUrl, type: "account_onboarding" });
      return link.url;
    },

    async payoutsEnabled(accountId) {
      const a = await stripe.accounts.retrieve(accountId);
      return Boolean(a.payouts_enabled && a.capabilities?.transfers === "active");
    },

    async transfer({ amountJpy, destination, sourceChargeId, transferGroup, idempotencyKey }) {
      // source_transaction：元の決済に結び付け、その決済の資金からだけ送る
      const t = await stripe.transfers.create(
        { amount: amountJpy, currency: "jpy", destination, source_transaction: sourceChargeId, transfer_group: transferGroup },
        { idempotencyKey },
      );
      return toTransfer(t);
    },

    async retrieveTransfer(transferId) {
      return toTransfer(await stripe.transfers.retrieve(transferId));
    },

    parseWebhook(rawBody, signature): GatewayEvent {
      if (!signature) throw new Error("署名がありません");
      const ev = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      const obj = ev.data.object as { id?: string };
      switch (ev.type) {
        case "payment_intent.amount_capturable_updated":
          return { id: ev.id, type: "authorized", intentId: obj.id };
        case "payment_intent.payment_failed":
          return { id: ev.id, type: "failed", intentId: obj.id };
        case "account.updated":
          return { id: ev.id, type: "account_updated", accountId: obj.id };
        default:
          return { id: ev.id, type: "other" };
      }
    },
  };
}
