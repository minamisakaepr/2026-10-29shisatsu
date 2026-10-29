// 注文 → まとめて引き受け → レシート → 配達 → 受け取り → 本決済 → 入金 の通しテストと、
// 二重決済の防止・設定値のスナップショット・お金の台帳・照合のテスト
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { autoComplete, payouts, reconcile } from "@/server/jobs";
import { completeOrder } from "@/server/payments/service";
import { verifyAuditChain } from "@/server/gate/audit";
import { balances } from "@/server/money/ledger";
import { anonymous, call, login, placeOrder, prisma, receiptForm } from "./helpers";

const journalsOf = (orderId: string) => prisma.moneyJournal.findMany({ where: { orderId }, include: { lines: true }, orderBy: { seq: "asc" } });

describe("通しの流れ（モック決済）", () => {
  it("2人分をまとめて引き受け、コード読み取りと自動完了で本決済、パシリへ入金まで", async () => {
    const taro = await login("customer@example.com");
    const hanako = await login("customer2@example.com");
    const runner = await login("runner@example.com");

    const o1 = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 2 }, { productId: "p-komugi-2", qty: 1 }]); // 620円
    const o2 = await placeOrder(hanako, [{ productId: "p-komugi-4", qty: 1 }]); // 420円
    const before1 = await prisma.order.findUniqueOrThrow({ where: { id: o1 } });
    expect(before1.status).toBe("placed");
    expect(before1.estimatedItemsJpy).toBe(620);
    // 仮押さえ（与信）の仕訳
    expect((await journalsOf(o1)).map((j) => j.eventType)).toEqual(["hold"]);
    expect((await journalsOf(o1))[0].amountJpy).toBe(before1.holdAmountJpy);

    // 引き受ける前に報酬を確認（まとめると1人あたりの配達料が下がる）
    const pv = await call(runner, "POST", "/api/runner/runs/preview", { body: { orderIds: [o1, o2] } });
    expect(pv.status).toBe(200);
    expect(pv.data.advanceJpy).toBe(1040);
    const run = await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [o1, o2] } });
    expect(run.status).toBe(200);
    expect(pv.data.rewardJpy).toBe((await prisma.run.findUniqueOrThrow({ where: { id: run.data.id } })).rewardJpy);
    const m1 = await prisma.order.findUniqueOrThrow({ where: { id: o1 } });
    expect(m1.status).toBe("matched");
    expect(m1.deliveryFeeJpy!).toBeLessThan(m1.estimatedDeliveryFeeJpy);

    // レシート登録（見積どおり → 承認不要）
    const rc = await call(runner, "POST", `/api/runner/runs/${run.data.id}/receipt`, { form: await receiptForm(run.data.id) });
    expect(rc.status).toBe(200);
    expect(rc.data.orders.every((o: any) => o.approvalStatus === "none")).toBe(true);
    const p1 = await prisma.order.findUniqueOrThrow({ where: { id: o1 } });
    expect(p1.finalTotalJpy).toBe(620 + p1.deliveryFeeJpy! + 62);

    // 配達
    expect((await call(runner, "POST", `/api/runner/orders/${o1}/deliver`, { body: {} })).status).toBe(200);
    expect((await call(runner, "POST", `/api/runner/orders/${o2}/deliver`, { body: {} })).status).toBe(200);

    // 1件目：パシリが受け取りコードを読み取る（間違ったコードは拒否）
    expect((await call(runner, "POST", `/api/runner/orders/${o1}/receive`, { body: { code: "000000" === p1.receiveCode ? "111111" : "000000" } })).status).toBe(400);
    const ok = await call(runner, "POST", `/api/runner/orders/${o1}/receive`, { body: { code: p1.receiveCode } });
    expect(ok.status).toBe(200);
    const c1 = await prisma.order.findUniqueOrThrow({ where: { id: o1 }, include: { payments: true, payout: true } });
    expect(c1.status).toBe("completed");
    expect(c1.payments[0]).toMatchObject({ status: "captured", amountCapturedJpy: c1.finalTotalJpy });
    expect(c1.payout?.amountJpy).toBe(c1.finalTotalJpy! - c1.platformFeeJpy!);
    expect((await journalsOf(o1)).map((j) => j.eventType)).toEqual(["hold", "capture", "fee", "release"]);

    // 2件目：お客さんが操作しないまま、自動完了の時間が過ぎた
    await prisma.order.update({ where: { id: o2 }, data: { deliveredAt: new Date(Date.now() - 1000 * 60 * 60 * 24) } });
    const ac = await autoComplete();
    expect(ac.failed).toBe(0);
    const c2 = await prisma.order.findUniqueOrThrow({ where: { id: o2 }, include: { transitions: true } });
    expect(c2.status).toBe("completed");
    expect(c2.transitions.at(-1)).toMatchObject({ to: "completed", actorRole: "system" });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.data.id } })).status).toBe("done");

    // 入金（same_day なので、すぐ送金）
    await payouts();
    const paid = await prisma.payout.findMany({ where: { orderId: { in: [o1, o2] } } });
    expect(paid.every((p) => p.status === "paid" && p.transferId)).toBe(true);
    const earn = await call(runner, "GET", "/api/runner/earnings");
    expect(earn.data.totals.paidJpy).toBeGreaterThanOrEqual(paid.reduce((s, p) => s + p.amountJpy, 0));
    expect(earn.data.titles).toContain("はじめてのパシリ");

    // 評価とありがとう
    expect((await call(taro, "POST", `/api/customer/orders/${o1}/rating`, { body: { stars: 5, message: "助かりました" } })).status).toBe(200);
    expect((await call(taro, "POST", `/api/customer/orders/${o1}/rating`, { body: { stars: 1 } })).status).toBe(409);
    expect((await call(runner, "GET", "/api/runner/earnings")).data.messages[0].message).toBe("助かりました");

    // お金の台帳：パシリへの未払いが残っていない、仮押さえも残っていない
    for (const id of [o1, o2]) {
      const js = await journalsOf(id);
      const sum = (acct: string) => js.flatMap((j) => j.lines).filter((l) => l.account === acct).reduce((s, l) => s + l.debitJpy - l.creditJpy, 0);
      expect(sum("payable:runner")).toBe(0);
      expect(sum("hold:authorized")).toBe(0);
      expect(-sum("revenue:platform_fee")).toBe((await prisma.order.findUniqueOrThrow({ where: { id } })).platformFeeJpy);
    }

    // 照合（台帳・DB・モックの Stripe 記録が一致）
    const rec = await reconcile();
    expect(rec).toMatchObject({ status: "ok", issues: 0 });
  });
});

describe("承認が必要なケース", () => {
  it("実額が仮押さえを超える → 承認待ちで配達不可 → 承認で与信やり直し → 完了", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const o = await placeOrder(taro, [{ productId: "p-komugi-5", qty: 2 }]); // 560円
    const run = (await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [o] } })).data;
    // 値上がりしていた：1個 500円
    await call(runner, "POST", `/api/runner/runs/${run.id}/receipt`, { form: await receiptForm(run.id, { "p-komugi-5": { price: 500 } }) });
    const p = await prisma.order.findUniqueOrThrow({ where: { id: o } });
    expect(p.approvalStatus).toBe("pending");
    expect(p.approvalReasons).toEqual(expect.arrayContaining(["over_hold", "price_diff"]));
    expect((await call(runner, "POST", `/api/runner/orders/${o}/deliver`, { body: {} })).status).toBe(409);

    const ap = await call(taro, "POST", `/api/customer/orders/${o}/approve`, { body: { decision: "approve" } });
    expect(ap.status).toBe(200);
    expect(ap.data.payment.mode).toBe("mock");
    expect(ap.data.payment.clientSecret).toBeTruthy();
    await call(taro, "POST", `/api/customer/orders/${o}/confirm-payment`, { body: {} });
    const a = await prisma.order.findUniqueOrThrow({ where: { id: o }, include: { payments: { orderBy: { createdAt: "asc" } } } });
    expect(a.approvalStatus).toBe("approved");
    expect(a.holdAmountJpy).toBe(a.finalTotalJpy);
    expect(a.payments.map((x) => [x.kind, x.status, x.active])).toEqual([["primary", "released", false], ["reauth", "authorized", true]]);

    await call(runner, "POST", `/api/runner/orders/${o}/deliver`, { body: {} });
    expect((await call(taro, "POST", `/api/customer/orders/${o}/receive`, { body: {} })).status).toBe(200);
    expect((await journalsOf(o)).map((j) => j.eventType)).toEqual(["hold", "hold", "release", "capture", "fee"]);
  });

  it("売り切れ・代替品を拒否すると運営対応（disputed）になり、admin がキャンセルすると仮押さえを解放", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const admin = await login("admin@example.com");
    const o = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }, { productId: "p-komugi-3", qty: 1 }]);
    const run = (await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [o] } })).data;
    await call(runner, "POST", `/api/runner/runs/${run.id}/receipt`, { form: await receiptForm(run.id, { "p-komugi-1": { outOfStock: true }, "p-komugi-3": { sub: "こしあんぱん" } }) });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o } })).approvalReasons).toEqual(expect.arrayContaining(["substitution", "out_of_stock"]));
    expect((await call(taro, "POST", `/api/customer/orders/${o}/approve`, { body: { decision: "reject", note: "代わりはいらない" } })).data.status).toBe("disputed");

    const d = await prisma.dispute.findFirstOrThrow({ where: { orderId: o } });
    expect((await call(admin, "POST", `/api/admin/disputes/${d.id}/resolve`, { body: { resolution: "cancel" } })).status).toBe(400); // 理由必須
    const r = await call(admin, "POST", `/api/admin/disputes/${d.id}/resolve`, { body: { resolution: "cancel", reason: "お客さんと相談してキャンセル" } });
    expect(r.data).toMatchObject({ status: "resolved", orderStatus: "cancelled" });
    expect((await journalsOf(o)).map((j) => j.eventType)).toEqual(["hold", "release"]);
  });
});

describe("キャンセル・期限切れ", () => {
  it("引き受け後のキャンセルは期限内だけ", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const o = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [o] } });
    await prisma.order.update({ where: { id: o }, data: { matchedAt: new Date(Date.now() - 1000 * 60 * 60) } });
    expect((await call(taro, "POST", `/api/customer/orders/${o}/cancel`, { body: {} })).status).toBe(409);
    await prisma.order.update({ where: { id: o }, data: { matchedAt: new Date() } });
    expect((await call(taro, "POST", `/api/customer/orders/${o}/cancel`, { body: {} })).data.status).toBe("cancelled");
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: o } })).status).toBe("released");
  });

  it("誰も引き受けない注文は期限切れになり、仮押さえを解放", async () => {
    const taro = await login("customer@example.com");
    const admin = await login("admin@example.com");
    const o = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    await prisma.order.update({ where: { id: o }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await call(admin, "POST", "/api/admin/jobs/expire_orders/run", { body: {} });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o } })).status).toBe("expired");
    expect((await journalsOf(o)).map((j) => j.eventType)).toEqual(["hold", "release"]);
  });
});

describe("二重決済の防止（冪等）", () => {
  it("受け取りボタンを同時に何回押しても、本決済は1回だけ", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const o = await placeOrder(taro, [{ productId: "p-komugi-2", qty: 1 }]);
    const run = (await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [o] } })).data;
    await call(runner, "POST", `/api/runner/runs/${run.id}/receipt`, { form: await receiptForm(run.id) });
    await call(runner, "POST", `/api/runner/orders/${o}/deliver`, { body: {} });
    const code = (await prisma.order.findUniqueOrThrow({ where: { id: o } })).receiveCode;
    const results = await Promise.all([
      call(taro, "POST", `/api/customer/orders/${o}/receive`, { body: {} }),
      call(taro, "POST", `/api/customer/orders/${o}/receive`, { body: {} }),
      call(runner, "POST", `/api/runner/orders/${o}/receive`, { body: { code } }),
      autoComplete().then(() => ({ status: 0 })),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    // 遅れて来た方は「もう終わっています」（409）か成功。内部エラー（500）にはしない
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    const js = await journalsOf(o);
    expect(js.filter((j) => j.eventType === "capture").length).toBe(1);
    expect(await prisma.payout.count({ where: { orderId: o } })).toBe(1);
    // あとから同じ処理を呼んでも何も増えない
    await expect(completeOrder(o, "delivered", { userId: null, role: "system" }, "再実行")).rejects.toThrow();
    await payouts();
    await payouts();
    expect((await journalsOf(o)).filter((j) => j.eventType === "payout").length).toBe(1);
  });

  it("同じ Webhook が2回来ても1回分だけ処理", async () => {
    const taro = await login("customer@example.com");
    const r = await call(taro, "POST", "/api/customer/orders", { body: { shopId: "shop-komugi", items: [{ productId: "p-komugi-1", qty: 1 }], dropoffLabel: "駅前" } });
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: r.data.id } });
    const { gateway } = await import("@/server/payments");
    await gateway().mockConfirm!(pay.intentId);
    const body = JSON.stringify({ id: `evt_${pay.id}`, type: "authorized", intentId: pay.intentId });
    const sig = createHmac("sha256", process.env.APP_SECRET!).update(body).digest("base64url");
    const send = () => call(anonymous(), "POST", "/api/webhooks/stripe", { raw: body, noCsrf: true, origin: null, headers: { "x-mock-signature": sig } });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await call(taro, "POST", `/api/customer/orders/${r.data.id}/confirm-payment`, { body: {} })).data.status).toBe("placed");
    expect((await journalsOf(r.data.id)).filter((j) => j.eventType === "hold").length).toBe(1);
    expect(await prisma.orderTransition.count({ where: { orderId: r.data.id, to: "placed" } })).toBe(1);
    await call(taro, "POST", `/api/customer/orders/${r.data.id}/cancel`, { body: {} });
  });
});

describe("設定値の変更とスナップショット", () => {
  it("変更は新しい注文から。進行中の注文の金額・報酬は変わらない。差し戻しもできる", async () => {
    const admin = await login("admin@example.com");
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const oldOrder = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    const old = await prisma.order.findUniqueOrThrow({ where: { id: oldOrder } });

    // 範囲外の値は拒否
    expect((await call(admin, "PUT", "/api/admin/settings/hold_buffer_rate", { body: { value: 5, reason: "テスト" } })).status).toBe(400);
    expect((await call(admin, "PUT", "/api/admin/settings/reward_per_order_jpy", { body: { value: "abc", reason: "テスト" } })).status).toBe(400);
    expect((await call(admin, "PUT", "/api/admin/settings/reward_per_order_jpy", { body: { value: 300 } })).status).toBe(400); // 理由なし
    // 変更
    const ch = await call(admin, "PUT", "/api/admin/settings/reward_per_order_jpy", { body: { value: 300, reason: "繁忙期のため報酬アップ" } });
    expect(ch.status).toBe(200);

    const newOrder = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    const neo = await prisma.order.findUniqueOrThrow({ where: { id: newOrder } });
    expect(neo.estimatedDeliveryFeeJpy - old.estimatedDeliveryFeeJpy).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: oldOrder } })).estimatedTotalJpy).toBe(old.estimatedTotalJpy);

    // 古い注文を引き受けたときの報酬は、古い設定値（100円）で計算される
    const pvOld = await call(runner, "POST", "/api/runner/runs/preview", { body: { orderIds: [oldOrder] } });
    const pvNew = await call(runner, "POST", "/api/runner/runs/preview", { body: { orderIds: [newOrder] } });
    expect(pvNew.data.rewardJpy - pvOld.data.rewardJpy).toBe(200);

    // 店舗別の上書き
    const ov = await call(admin, "PUT", "/api/admin/settings/reward_per_order_jpy/overrides", { body: { scopeType: "shop", scopeId: "shop-hinata", value: 50, reason: "この店は近いので" } });
    expect(ov.status).toBe(200);
    const hinata = await placeOrder(taro, [{ productId: "p-hinata-1", qty: 1 }], "shop-hinata");
    expect(((await prisma.order.findUniqueOrThrow({ where: { id: hinata } })).settingsSnapshot as any).reward_per_order_jpy).toBe(50);

    // 履歴と差し戻し
    const hist = await call(admin, "GET", "/api/admin/settings/history?key=reward_per_order_jpy");
    const change = hist.data.find((h: any) => h.scopeType === "global" && h.newValue === 300);
    expect(change.oldValue).toBe(100);
    expect(change.reason).toBe("繁忙期のため報酬アップ");
    expect((await call(admin, "POST", `/api/admin/settings/history/${change.id}/revert`, { body: { reason: "繁忙期が終わった" } })).status).toBe(200);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: "reward_per_order_jpy" } })).value).toBe(100);
    const ovRow = await prisma.settingOverride.findFirstOrThrow({ where: { key: "reward_per_order_jpy" } });
    await call(admin, "DELETE", `/api/admin/settings/reward_per_order_jpy/overrides/${ovRow.id}`, { body: { reason: "テスト後の片付け" } });
    expect(await prisma.settingOverride.count()).toBe(0);
    // 設定変更は通行記録にも残る
    expect(await prisma.auditLedger.count({ where: { entrance: "settings.change" } })).toBeGreaterThanOrEqual(3);

    for (const id of [oldOrder, newOrder, hinata]) await call(taro, "POST", `/api/customer/orders/${id}/cancel`, { body: {} });
  });
});

describe("台帳の改ざん防止", () => {
  it("通行記録・お金の台帳は UPDATE / DELETE できない", async () => {
    const a = await prisma.auditLedger.findFirstOrThrow();
    await expect(prisma.auditLedger.update({ where: { seq: a.seq }, data: { result: "allow" } })).rejects.toThrow(/追記専用/);
    await expect(prisma.auditLedger.delete({ where: { seq: a.seq } })).rejects.toThrow(/追記専用/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditLedger"')).rejects.toThrow();
    const j = await prisma.moneyJournal.findFirstOrThrow();
    await expect(prisma.moneyJournal.update({ where: { seq: j.seq }, data: { amountJpy: 1 } })).rejects.toThrow(/追記専用/);
    await expect(prisma.moneyLine.updateMany({ data: { debitJpy: 0 } })).rejects.toThrow(/追記専用/);
  });
  it("借方と貸方が合わない仕訳は DB が拒否", async () => {
    await expect(
      prisma.moneyJournal.create({ data: { eventType: "fee", amountJpy: 10, idempotencyKey: "bad-journal", lines: { create: [{ account: "a", debitJpy: 10 }, { account: "b", creditJpy: 9 }] } } }),
    ).rejects.toThrow(/一致しません/);
  });
  it("ハッシュチェーンが最初から最後までつながっている", async () => {
    const r = await verifyAuditChain();
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(50);
  });
  it("全体の残高：仮押さえは解放か本決済で必ず消える（進行中のぶんだけ残る）", async () => {
    const b = await balances();
    const open = await prisma.payment.aggregate({ where: { status: { in: ["authorized", "capture_pending"] } }, _sum: { amountAuthorizedJpy: true } });
    expect(b["hold:authorized"] ?? 0).toBe(open._sum.amountAuthorizedJpy ?? 0);
  });
});
