// 金額・報酬の計算。設定値を受け取って金額を返すだけの純粋な関数（DB も時計も使わない）。
// 計算のルールは docs/design.md「4-1. 金額の計算」を参照。金額はすべて円の整数。
import type { Settings } from "../settings/definitions";

export type PricingSettings = Pick<
  Settings,
  | "hold_buffer_rate"
  | "price_diff_tolerance_rate"
  | "reward_base_jpy"
  | "reward_per_order_jpy"
  | "surcharge_rain_jpy"
  | "surcharge_early_jpy"
  | "surcharge_per_km_jpy"
  | "platform_fee_rate"
>;

// 率は「1万分のいくつ」に直して整数で計算する（0.1 などの小数の誤差を避けるため）
const BP = 10_000;
const toBp = (rate: number) => Math.round(rate * BP);
const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

export interface LineItem {
  unitPriceJpy: number;
  qty: number;
}

export function itemsTotal(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.unitPriceJpy * i.qty, 0);
}

export interface RunConditions {
  /** まとめた注文の数（1以上） */
  runSize: number;
  isRain: boolean;
  isEarly: boolean;
  /** 店から一番遠い受け渡し場所までの距離 */
  distanceKm: number;
}

export interface DeliveryFee {
  /** 割り勘する部分（基本報酬＋雨＋早朝＋距離）の合計 */
  sharedJpy: number;
  /** そのうち、この注文が払う分 */
  sharedPartJpy: number;
  perOrderJpy: number;
  totalJpy: number;
  detail: { baseJpy: number; rainJpy: number; earlyJpy: number; distanceJpy: number; km: number };
}

/** 注文1件ぶんの配達料（＝パシリの報酬のうち、この注文の分） */
export function deliveryFee(s: PricingSettings, c: RunConditions): DeliveryFee {
  if (!Number.isInteger(c.runSize) || c.runSize < 1) throw new Error("runSize は1以上の整数です");
  const km = Math.max(0, Math.ceil(c.distanceKm - 1e-9));
  const detail = {
    baseJpy: s.reward_base_jpy,
    rainJpy: c.isRain ? s.surcharge_rain_jpy : 0,
    earlyJpy: c.isEarly ? s.surcharge_early_jpy : 0,
    distanceJpy: km * s.surcharge_per_km_jpy,
    km,
  };
  const sharedJpy = detail.baseJpy + detail.rainJpy + detail.earlyJpy + detail.distanceJpy;
  const sharedPartJpy = ceilDiv(sharedJpy, c.runSize);
  return { sharedJpy, sharedPartJpy, perOrderJpy: s.reward_per_order_jpy, totalJpy: sharedPartJpy + s.reward_per_order_jpy, detail };
}

/** 運営手数料（商品額 × 率、四捨五入） */
export function platformFee(s: Pick<PricingSettings, "platform_fee_rate">, itemsJpy: number): number {
  return Math.floor((itemsJpy * toBp(s.platform_fee_rate) + BP / 2) / BP);
}

/** 仮押さえ額（見積合計 ×（1 + 上乗せ率）、切り上げ） */
export function holdAmount(s: Pick<PricingSettings, "hold_buffer_rate">, estimatedTotalJpy: number): number {
  return ceilDiv(estimatedTotalJpy * (BP + toBp(s.hold_buffer_rate)), BP);
}

export interface Estimate {
  itemsJpy: number;
  deliveryFeeJpy: number;
  platformFeeJpy: number;
  totalJpy: number;
  holdJpy: number;
}

/** 注文時の見積。配達料は「1件だけで頼んだ場合」（＝いちばん高い場合）で出す */
export function estimateOrder(
  s: PricingSettings,
  items: LineItem[],
  cond: { isRain: boolean; isEarly: boolean; distanceKm: number },
): Estimate {
  const itemsJpy = itemsTotal(items);
  const deliveryFeeJpy = deliveryFee(s, { ...cond, runSize: 1 }).totalJpy;
  const platformFeeJpy = platformFee(s, itemsJpy);
  const totalJpy = itemsJpy + deliveryFeeJpy + platformFeeJpy;
  return { itemsJpy, deliveryFeeJpy, platformFeeJpy, totalJpy, holdJpy: holdAmount(s, totalJpy) };
}

export interface RunOrderInput {
  orderId: string;
  /** その注文の、注文時点の設定値 */
  settings: PricingSettings;
  distanceKm: number;
  /** 雨の日割増をつけるか（その注文の注文時点の設定値 rain_active） */
  isRain: boolean;
  /** 引き受けた時刻が、その注文の注文時点の early_hours に入っているか */
  isEarly: boolean;
}

export interface RunReward {
  rewardJpy: number;
  distanceKm: number;
  perOrder: { orderId: string; deliveryFeeJpy: number; fee: DeliveryFee }[];
}

/** まとめた注文ぶんの報酬。各注文の配達料を、その注文自身の設定値で計算して合計する */
export function runReward(orders: RunOrderInput[]): RunReward {
  if (orders.length === 0) throw new Error("注文がありません");
  const distanceKm = Math.max(...orders.map((o) => o.distanceKm));
  const perOrder = orders.map((o) => {
    const fee = deliveryFee(o.settings, { runSize: orders.length, distanceKm, isRain: o.isRain, isEarly: o.isEarly });
    return { orderId: o.orderId, deliveryFeeJpy: fee.totalJpy, fee };
  });
  return { rewardJpy: perOrder.reduce((s, p) => s + p.deliveryFeeJpy, 0), distanceKm, perOrder };
}

export interface FinalAmounts {
  itemsJpy: number;
  deliveryFeeJpy: number;
  platformFeeJpy: number;
  totalJpy: number;
  /** パシリに渡る額（立替代金＋報酬） */
  runnerJpy: number;
}

export function finalAmounts(s: Pick<PricingSettings, "platform_fee_rate">, actualItemsJpy: number, deliveryFeeJpy: number): FinalAmounts {
  const platformFeeJpy = platformFee(s, actualItemsJpy);
  const totalJpy = actualItemsJpy + deliveryFeeJpy + platformFeeJpy;
  return { itemsJpy: actualItemsJpy, deliveryFeeJpy, platformFeeJpy, totalJpy, runnerJpy: totalJpy - platformFeeJpy };
}

export type ApprovalReason = "over_hold" | "price_diff" | "substitution" | "out_of_stock";

/** お客さんの承認が必要か。必要な理由の一覧を返す（空なら承認不要） */
export function approvalReasons(
  s: Pick<PricingSettings, "price_diff_tolerance_rate">,
  a: { estimatedItemsJpy: number; actualItemsJpy: number; finalTotalJpy: number; holdJpy: number; hasSubstitution: boolean; hasOutOfStock: boolean },
): ApprovalReason[] {
  const reasons: ApprovalReason[] = [];
  if (a.finalTotalJpy > a.holdJpy) reasons.push("over_hold");
  // |実額 − 見積| ÷ 見積 ＞ 許容率 を、割り算を使わずに比べる
  const diff = Math.abs(a.actualItemsJpy - a.estimatedItemsJpy) * BP;
  if (a.estimatedItemsJpy === 0 ? a.actualItemsJpy > 0 : diff > a.estimatedItemsJpy * toBp(s.price_diff_tolerance_rate)) {
    reasons.push("price_diff");
  }
  if (a.hasSubstitution) reasons.push("substitution");
  if (a.hasOutOfStock) reasons.push("out_of_stock");
  return reasons;
}
