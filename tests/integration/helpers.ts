// 結合テスト用：本物の門番（dispatch）に、ブラウザと同じ形のリクエストを送る
import { boot } from "@/server/boot";
import { dispatch } from "@/server/gate/dispatch";
import { prisma } from "@/server/db";
import { TEST_PASSWORD } from "../../prisma/seed";

boot();

const ORIGIN = "http://localhost:3000";
const CSRF = "test-csrf-token";

export interface Client {
  cookie: string;
  userId: string | null;
}

export const anonymous = (): Client => ({ cookie: `pashiri_csrf=${CSRF}`, userId: null });

export interface CallOpts {
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  noCsrf?: boolean;
  origin?: string | null;
  raw?: string;
}

export async function call(c: Client, method: string, path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = { cookie: c.cookie, ...opts.headers };
  if (method !== "GET") {
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (!opts.noCsrf) headers["x-csrf-token"] = CSRF;
  }
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await dispatch(new Request(`${ORIGIN}${path}`, { method, headers, body }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* JSON 以外（ファイルなど） */
  }
  return { status: res.status, data: json?.data, error: json?.error, headers: res.headers, text };
}

export async function login(email: string, password = TEST_PASSWORD): Promise<Client> {
  const r = await call(anonymous(), "POST", "/api/auth/login", { body: { email, password } });
  if (r.status !== 200) throw new Error(`ログイン失敗 ${email}: ${JSON.stringify(r.error)}`);
  const token = /pashiri_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")![1];
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: `pashiri_csrf=${CSRF}; pashiri_session=${token}`, userId: user.id };
}

// 1x1 の PNG 画像（レシートの代わり）
export const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

export async function placeOrder(c: Client, items: { productId: string; qty: number }[], shopId = "shop-komugi") {
  const r = await call(c, "POST", "/api/customer/orders", { body: { shopId, items, dropoffLabel: "公園の入口" } });
  if (r.status !== 200) throw new Error(`注文失敗: ${JSON.stringify(r.error)}`);
  const conf = await call(c, "POST", `/api/customer/orders/${r.data.id}/confirm-payment`, { body: {} });
  if (conf.data?.status !== "placed") throw new Error(`与信失敗: ${JSON.stringify(conf)}`);
  return r.data.id as string;
}

/** レシート登録用のフォーム。prices を省略すると見積どおり */
export async function receiptForm(runId: string, override: Record<string, { price?: number; qty?: number; outOfStock?: boolean; sub?: string }> = {}) {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { orders: { where: { status: "matched" }, include: { items: true } } } });
  const fd = new FormData();
  fd.append("receipt", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "r.png");
  fd.append("data", JSON.stringify({
    orders: run.orders.map((o) => ({
      orderId: o.id,
      items: o.items.map((i) => ({
        itemId: i.id,
        actualUnitPriceJpy: override[i.productId]?.price ?? i.unitPriceJpy,
        actualQty: override[i.productId]?.qty ?? i.qty,
        outOfStock: override[i.productId]?.outOfStock ?? false,
        substitutionName: override[i.productId]?.sub ?? null,
      })),
    })),
  }));
  return fd;
}

export { prisma };
