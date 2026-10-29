// 環境変数の読み込みと安全チェック。秘密の値はここ以外で process.env から読まない。
export type PaymentMode = "mock" | "stripe";

export interface Env {
  appUrl: string;
  appSecret: string;
  paymentMode: PaymentMode;
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
  storageDir: string;
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const appSecret = process.env.APP_SECRET ?? "";
  if (appSecret.length < 32) {
    throw new Error("APP_SECRET は32文字以上にしてください（.env を確認）");
  }
  const mode = (process.env.PAYMENT_MODE ?? "mock") as PaymentMode;
  if (mode !== "mock" && mode !== "stripe") {
    throw new Error(`PAYMENT_MODE は mock か stripe です（いま: ${mode}）`);
  }
  const sk = process.env.STRIPE_SECRET_KEY ?? "";
  const pk = process.env.STRIPE_PUBLISHABLE_KEY ?? "";
  // 本番キーの誤投入を防ぐ（このアプリはテストモード専用）
  if (sk.startsWith("sk_live_") || sk.startsWith("rk_live_") || pk.startsWith("pk_live_")) {
    throw new Error("Stripe の本番キー（*_live_）が設定されています。このアプリはテストモード専用です。");
  }
  if (mode === "stripe") {
    if (!sk.startsWith("sk_test_") || !pk.startsWith("pk_test_")) {
      throw new Error("PAYMENT_MODE=stripe には sk_test_ / pk_test_ で始まるキーが必要です");
    }
    if (!process.env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
      throw new Error("PAYMENT_MODE=stripe には STRIPE_WEBHOOK_SECRET（whsec_...）が必要です");
    }
  }
  cached = {
    appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    appSecret,
    paymentMode: mode,
    stripeSecretKey: sk,
    stripePublishableKey: pk,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    storageDir: process.env.STORAGE_DIR ?? "./storage",
  };
  return cached;
}

/** テスト用：環境変数を読み直す */
export function resetEnvCache() {
  cached = null;
}
