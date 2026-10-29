import { describe, expect, it } from "vitest";
import { approvalReasons, deliveryFee, estimateOrder, finalAmounts, holdAmount, platformFee, runReward, type PricingSettings } from "@/server/domain/pricing";

const S: PricingSettings = {
  hold_buffer_rate: 0.2,
  price_diff_tolerance_rate: 0.1,
  reward_base_jpy: 150,
  reward_per_order_jpy: 100,
  surcharge_rain_jpy: 100,
  surcharge_early_jpy: 100,
  surcharge_per_km_jpy: 50,
  platform_fee_rate: 0.1,
};

describe("配達料（パシリの報酬）", () => {
  it("1件だけ・晴れ・日中・1km未満: 基本報酬 + 1件ごと + 距離1km分", () => {
    const f = deliveryFee(S, { runSize: 1, isRain: false, isEarly: false, distanceKm: 0.4 });
    expect(f.detail.km).toBe(1);
    expect(f.totalJpy).toBe(150 + 50 + 100);
  });

  it("まとめると、基本報酬と割増を割り勘する（切り上げ）", () => {
    const f = deliveryFee(S, { runSize: 3, isRain: true, isEarly: true, distanceKm: 1.2 });
    // 割り勘部分: 150 + 100 + 100 + 2km*50 = 450 → 450/3 = 150
    expect(f.sharedJpy).toBe(450);
    expect(f.sharedPartJpy).toBe(150);
    expect(f.totalJpy).toBe(250);
    const g = deliveryFee(S, { runSize: 4, isRain: false, isEarly: false, distanceKm: 1 });
    expect(g.sharedPartJpy).toBe(50); // 200/4
    expect(deliveryFee(S, { runSize: 3, isRain: false, isEarly: false, distanceKm: 1 }).sharedPartJpy).toBe(67); // 200/3 = 66.6.. → 67
  });

  it("ちょうど 2.0km は 2km として数える（浮動小数の誤差で 3km にしない）", () => {
    expect(deliveryFee(S, { runSize: 1, isRain: false, isEarly: false, distanceKm: 2.0 }).detail.km).toBe(2);
  });

  it("runSize が 0 や小数ならエラー", () => {
    expect(() => deliveryFee(S, { runSize: 0, isRain: false, isEarly: false, distanceKm: 1 })).toThrow();
    expect(() => deliveryFee(S, { runSize: 1.5, isRain: false, isEarly: false, distanceKm: 1 })).toThrow();
  });
});

describe("手数料・仮押さえ", () => {
  it("手数料は四捨五入（小数の誤差なし）", () => {
    expect(platformFee(S, 1234)).toBe(123);
    expect(platformFee(S, 1005)).toBe(101); // 100.5 → 101
    expect(platformFee({ platform_fee_rate: 0.07 }, 1000)).toBe(70);
  });
  it("仮押さえは切り上げ", () => {
    expect(holdAmount(S, 1000)).toBe(1200);
    expect(holdAmount(S, 1001)).toBe(1202); // 1201.2 → 1202
    expect(holdAmount({ hold_buffer_rate: 0 }, 999)).toBe(999);
  });
  it("見積は「1件だけで頼んだ場合」で出す", () => {
    const e = estimateOrder(S, [{ unitPriceJpy: 200, qty: 3 }, { unitPriceJpy: 260, qty: 1 }], { isRain: false, isEarly: false, distanceKm: 0.5 });
    expect(e.itemsJpy).toBe(860);
    expect(e.deliveryFeeJpy).toBe(300);
    expect(e.platformFeeJpy).toBe(86);
    expect(e.totalJpy).toBe(1246);
    expect(e.holdJpy).toBe(1496); // 1246*1.2 = 1495.2 → 1496
  });
});

describe("まとめた注文の報酬", () => {
  it("各注文の注文時点の設定値で計算して合計する", () => {
    const changed = { ...S, reward_per_order_jpy: 300 }; // あとから設定を変えた注文
    const r = runReward([
      { orderId: "a", settings: S, distanceKm: 0.5, isRain: false, isEarly: false },
      { orderId: "b", settings: changed, distanceKm: 1.5, isRain: false, isEarly: false },
    ]);
    // 距離は一番遠い 1.5km → 2km。割り勘部分 = (150 + 100) / 2 = 125
    expect(r.distanceKm).toBe(1.5);
    expect(r.perOrder[0].deliveryFeeJpy).toBe(125 + 100);
    expect(r.perOrder[1].deliveryFeeJpy).toBe(125 + 300);
    expect(r.rewardJpy).toBe(225 + 425);
  });
  it("注文なしはエラー", () => {
    expect(() => runReward([])).toThrow();
  });
});

describe("最終金額と承認", () => {
  it("パシリに渡るのは 立替代金 + 配達料（手数料は除く）", () => {
    const f = finalAmounts(S, 900, 250);
    expect(f).toEqual({ itemsJpy: 900, deliveryFeeJpy: 250, platformFeeJpy: 90, totalJpy: 1240, runnerJpy: 1150 });
  });
  const base = { estimatedItemsJpy: 1000, actualItemsJpy: 1000, finalTotalJpy: 1400, holdJpy: 1500, hasSubstitution: false, hasOutOfStock: false };
  it("許容率ちょうどは承認不要、超えたら承認", () => {
    expect(approvalReasons(S, { ...base, actualItemsJpy: 1100 })).toEqual([]);
    expect(approvalReasons(S, { ...base, actualItemsJpy: 900 })).toEqual([]);
    expect(approvalReasons(S, { ...base, actualItemsJpy: 1101 })).toEqual(["price_diff"]);
  });
  it("仮押さえ額を超えたら承認", () => {
    expect(approvalReasons(S, { ...base, finalTotalJpy: 1501 })).toContain("over_hold");
    expect(approvalReasons(S, { ...base, finalTotalJpy: 1500 })).toEqual([]);
  });
  it("代替品・売り切れは承認", () => {
    expect(approvalReasons(S, { ...base, hasSubstitution: true, hasOutOfStock: true })).toEqual(["substitution", "out_of_stock"]);
  });
});
