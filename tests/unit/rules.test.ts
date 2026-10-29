import { describe, expect, it } from "vitest";
import { canTransition, TRANSITIONS } from "@/server/domain/orderState";
import { inTimeRange, payoutScheduledAt, startOfMonth } from "@/server/domain/time";
import { earnedTitles } from "@/server/domain/titles";
import { distanceKm } from "@/server/domain/geo";
import { validateTitleRules, validateValue } from "@/server/settings/definitions";
import { isBalanced, linesFor } from "@/server/money/ledger";
import { scrub, chainHash, rowPayload } from "@/server/gate/audit";
import { detectImage } from "@/server/lib/storage";

describe("状態遷移", () => {
  it("表にある遷移だけ許可", () => {
    expect(canTransition("placed", "matched", "runner")).toBe(true);
    expect(canTransition("placed", "matched", "customer")).toBe(false);
    expect(canTransition("draft", "completed", "admin")).toBe(false);
    expect(canTransition("completed", "cancelled", "admin")).toBe(false);
    expect(canTransition("delivered", "completed", "system")).toBe(true);
    expect(canTransition("disputed", "completed", "system")).toBe(false); // トラブルは自動で完了させない
  });
  it("終わった状態からはどこにも行けない", () => {
    for (const end of ["completed", "cancelled", "expired"]) {
      expect(TRANSITIONS.filter((t) => t.from === end)).toEqual([]);
    }
  });
});

describe("時刻", () => {
  it("早朝の判定（Asia/Tokyo）", () => {
    expect(inTimeRange(new Date("2026-10-29T21:30:00Z"), "06:00-08:00", "Asia/Tokyo")).toBe(true); // 06:30 JST
    expect(inTimeRange(new Date("2026-10-29T23:00:00Z"), "06:00-08:00", "Asia/Tokyo")).toBe(false); // 08:00 JST（終わりは含まない）
    expect(inTimeRange(new Date("2026-10-29T14:00:00Z"), "22:00-02:00", "Asia/Tokyo")).toBe(true); // 23:00 JST（日またぎ）
  });
  it("入金タイミング", () => {
    const now = new Date("2026-10-29T05:00:00Z"); // 木曜 14:00 JST
    expect(payoutScheduledAt(now, "same_day", "09:00", "Asia/Tokyo")).toEqual(now);
    expect(payoutScheduledAt(now, "next_day", "09:00", "Asia/Tokyo").toISOString()).toBe("2026-10-30T00:00:00.000Z"); // 金曜 9:00 JST
    expect(payoutScheduledAt(now, "weekly", "09:00", "Asia/Tokyo").toISOString()).toBe("2026-11-02T00:00:00.000Z"); // 次の月曜
  });
  it("月初め（JST）", () => {
    expect(startOfMonth(new Date("2026-10-31T16:00:00Z"), "Asia/Tokyo").toISOString()).toBe("2026-10-31T15:00:00.000Z"); // 11/1 0:00 JST
  });
});

describe("称号", () => {
  const rules = { エースパシリ: { monthly_runs: 20 }, 信頼のパシリ: { total_runs: 10, min_avg_rating: 4.5 } };
  it("条件をすべて満たした称号だけ", () => {
    expect(earnedTitles(rules, { monthlyRuns: 20, totalRuns: 25, avgRating: 4.4 })).toEqual(["エースパシリ"]);
    expect(earnedTitles(rules, { monthlyRuns: 3, totalRuns: 10, avgRating: 4.5 })).toEqual(["信頼のパシリ"]);
    expect(earnedTitles(rules, { monthlyRuns: 3, totalRuns: 10, avgRating: null })).toEqual([]);
  });
});

describe("設定値の入力チェック", () => {
  it("範囲・型", () => {
    expect(validateValue({ type: "decimal", min: 0, max: 1 }, 0.5)).toBeNull();
    expect(validateValue({ type: "decimal", min: 0, max: 1 }, 1.5)).not.toBeNull();
    expect(validateValue({ type: "int", min: 1 }, 2.5)).not.toBeNull();
    expect(validateValue({ type: "int" }, "5")).not.toBeNull();
    expect(validateValue({ type: "enum", options: ["a", "b"] }, "c")).not.toBeNull();
    expect(validateValue({ type: "timerange" }, "06:00-08:00")).toBeNull();
    expect(validateValue({ type: "timerange" }, "6:00-8:00")).not.toBeNull();
    expect(validateValue({ type: "bool" }, "true")).not.toBeNull();
  });
  it("称号の条件", () => {
    expect(validateTitleRules({ A: { monthly_runs: 3 } })).toBeNull();
    expect(validateTitleRules({ A: { unknown: 3 } })).not.toBeNull();
    expect(validateTitleRules({ A: { monthly_runs: -1 } })).not.toBeNull();
  });
});

describe("お金の台帳（複式簿記）", () => {
  it("すべてのイベントの仕訳は借方＝貸方", () => {
    for (const ev of ["hold", "release", "capture", "fee", "payout"] as const) expect(isBalanced(linesFor(ev, 1234))).toBe(true);
    expect(isBalanced(linesFor("refund", 1240, { feeJpy: 90 }))).toBe(true);
  });
});

describe("通行記録", () => {
  it("パスワード・カード・トークン・コードは伏せ字", () => {
    const s = scrub({ email: "a@b", password: "x", nested: { cardNumber: "4242", receiveCode: "123456", clientSecret: "pi_x" }, ok: 1 }) as Record<string, any>;
    expect(s.password).toBe("[伏せ字]");
    expect(s.nested.cardNumber).toBe("[伏せ字]");
    expect(s.nested.receiveCode).toBe("[伏せ字]");
    expect(s.nested.clientSecret).toBe("[伏せ字]");
    expect(s.ok).toBe(1);
  });
  it("1文字でも変えるとハッシュが変わる", () => {
    const row = { at: new Date(0), userId: "u", role: "customer", entrance: "x", operation: "read", target: null, result: "allow", ip: null, detail: { a: 1 } };
    const h1 = chainHash("GENESIS", rowPayload(row));
    const h2 = chainHash("GENESIS", rowPayload({ ...row, result: "deny" }));
    expect(h1).not.toBe(h2);
    // キーの順番が違っても同じ内容なら同じハッシュ（DB の JSON はキーの順番を保証しない）
    expect(chainHash("GENESIS", rowPayload({ ...row, detail: { a: 1 } }))).toBe(h1);
  });
});

describe("その他", () => {
  it("距離", () => {
    expect(distanceKm({ lat: 35.7033, lng: 139.5797 }, { lat: 35.7033, lng: 139.5797 })).toBe(0);
    const d = distanceKm({ lat: 35.7033, lng: 139.5797 }, { lat: 35.7060, lng: 139.5760 });
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(0.6);
  });
  it("画像の判定は中身で行う", () => {
    expect(detectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(detectImage(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectImage(Buffer.from("RIFF0000WAVE"))).toBeNull();
  });
});
