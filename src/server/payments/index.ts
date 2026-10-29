import { loadEnv } from "../env";
import type { PaymentGateway } from "./gateway";
import { createMockGateway } from "./mock";
import { createStripeGateway } from "./stripe";

let gw: PaymentGateway | null = null;

export function gateway(): PaymentGateway {
  if (gw) return gw;
  const env = loadEnv();
  gw = env.paymentMode === "stripe"
    ? createStripeGateway(env.stripeSecretKey, env.stripePublishableKey, env.stripeWebhookSecret)
    : createMockGateway(env.appSecret);
  return gw;
}

/** テスト用：決済の相手を差し替える */
export function setGateway(g: PaymentGateway | null) {
  gw = g;
}
