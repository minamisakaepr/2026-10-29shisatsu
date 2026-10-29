// 決済の共通の形。Stripe（テストモード）とモック（偽物の Stripe）が同じ形で使える。
// カード番号はアプリに一切来ない（Stripe の画面が直接受け取る）。
// Stripe への書き込みには必ず冪等キーを付ける（同じキー＝同じ要求として1回分しか処理されない）。

export type IntentStatus = "requires_confirmation" | "authorized" | "captured" | "canceled" | "failed";

export interface IntentInfo {
  id: string;
  status: IntentStatus;
  amountAuthorizedJpy: number;
  amountCapturedJpy: number;
  amountRefundedJpy: number;
  chargeId: string | null;
}

export interface TransferInfo {
  id: string;
  amountJpy: number;
  destination: string;
  reversed: boolean;
}

export interface GatewayEvent {
  id: string;
  type: "authorized" | "failed" | "account_updated" | "other";
  intentId?: string;
  accountId?: string;
}

export interface PaymentGateway {
  mode: "mock" | "stripe";
  publishableKey: string | null;
  createAuthorization(a: {
    amountJpy: number;
    orderId: string;
    customer: { id: string; email: string; stripeCustomerId: string | null };
    idempotencyKey: string;
  }): Promise<{ intentId: string; clientSecret: string; stripeCustomerId: string | null }>;
  /** モック専用：お客さんがテストカードで支払いを確定したことにする */
  mockConfirm?(intentId: string): Promise<void>;
  retrieveIntent(intentId: string): Promise<IntentInfo>;
  capture(intentId: string, amountJpy: number, idempotencyKey: string): Promise<IntentInfo>;
  cancel(intentId: string, idempotencyKey: string): Promise<IntentInfo>;
  refund(intentId: string, amountJpy: number, idempotencyKey: string): Promise<{ refundId: string }>;
  createConnectedAccount(u: { id: string; email: string }, idempotencyKey: string): Promise<string>;
  onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string | null>;
  payoutsEnabled(accountId: string): Promise<boolean>;
  transfer(t: { amountJpy: number; destination: string; sourceChargeId: string; transferGroup: string; idempotencyKey: string }): Promise<TransferInfo>;
  retrieveTransfer(transferId: string): Promise<TransferInfo>;
  /** Webhook の署名を検証して中身を返す。署名が正しくなければ例外 */
  parseWebhook(rawBody: string, signature: string | null): GatewayEvent;
}
