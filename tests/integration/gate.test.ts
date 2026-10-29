// 門番・アクセス台帳・不正操作のテスト（本物の DB とモック決済を使う）
import { describe, expect, it } from "vitest";
import { anonymous, call, login, placeOrder, prisma, receiptForm } from "./helpers";

async function lastAudit(entrance?: string) {
  return prisma.auditLedger.findFirst({ where: entrance ? { entrance } : {}, orderBy: { seq: "desc" } });
}

describe("台帳にない出入り口は拒否（デフォルト拒否）", () => {
  it("存在しない API は 404。拒否も通行記録に残る", async () => {
    const admin = await login("admin@example.com");
    const r = await call(admin, "GET", "/api/admin/dump-all-users");
    expect(r.status).toBe(404);
    const a = await lastAudit();
    expect(a).toMatchObject({ entrance: "unknown", result: "deny", userId: admin.userId, target: "/api/admin/dump-all-users" });
  });
  it("台帳にないメソッドも拒否", async () => {
    const c = await login("customer@example.com");
    expect((await call(c, "DELETE", "/api/customer/orders")).status).toBe(404);
  });
  it("台帳にないロールは拒否（未ログインは 401、ログイン済みは 403）", async () => {
    expect((await call(anonymous(), "GET", "/api/admin/settings")).status).toBe(401);
    const c = await login("customer@example.com");
    expect((await call(c, "GET", "/api/admin/settings")).status).toBe(403);
    expect((await call(c, "GET", "/api/runner/orders/nearby")).status).toBe(403);
    const runner = await login("runner@example.com");
    expect((await call(runner, "POST", "/api/customer/orders", { body: {} })).status).toBe(403);
    const shop = await login("shop@example.com");
    expect((await call(shop, "GET", "/api/admin/audit")).status).toBe(403);
    expect((await lastAudit())?.result).toBe("deny");
  });
  it("定期処理は HTTP から呼べない。admin の手動実行は system として記録", async () => {
    const admin = await login("admin@example.com");
    expect((await call(admin, "POST", "/api/jobs/payouts", { body: {} })).status).toBe(404);
    const r = await call(admin, "POST", "/api/admin/jobs/expire_orders/run", { body: {} });
    expect(r.status).toBe(200);
    expect(await lastAudit("job.expire_orders")).toMatchObject({ role: "system", result: "allow" });
    expect((await call(admin, "POST", "/api/admin/jobs/drop_tables/run", { body: {} })).status).toBe(400);
  });
});

describe("CSRF・入力チェック", () => {
  it("CSRF トークンがない書き込みは拒否", async () => {
    const c = await login("customer@example.com");
    expect((await call(c, "POST", "/api/customer/orders", { body: {}, noCsrf: true })).status).toBe(403);
  });
  it("別サイトからの書き込み（Origin 違い）は拒否", async () => {
    const c = await login("customer@example.com");
    expect((await call(c, "POST", "/api/customer/orders", { body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(c, "POST", "/api/customer/orders", { body: {}, origin: null })).status).toBe(403);
  });
  it("おかしな入力は 400（SQL っぽい文字列も、ただの文字として扱われる）", async () => {
    const c = await login("customer@example.com");
    expect((await call(c, "POST", "/api/customer/orders", { body: { shopId: "x", items: [{ productId: "p", qty: -1 }], dropoffLabel: "a" } })).status).toBe(400);
    const r = await call(c, "GET", "/api/customer/orders/' OR 1=1 --");
    expect(r.status).toBe(404);
  });
});

describe("ログイン", () => {
  it("パスワード違いが続くとロック。パスワードは記録に残らない", async () => {
    const s = (await prisma.setting.findUniqueOrThrow({ where: { key: "login_max_attempts" } })).value as number;
    try {
      for (let i = 0; i < s; i++) {
        expect((await call(anonymous(), "POST", "/api/auth/login", { body: { email: "shop@example.com", password: `wrong-${i}` } })).status).toBe(401);
      }
      expect((await call(anonymous(), "POST", "/api/auth/login", { body: { email: "shop@example.com", password: "pashiri-test-1234" } })).status).toBe(429);
      const rows = await prisma.auditLedger.findMany({ where: { entrance: "api.auth.login" } });
      // 通し番号（seq）は BigInt なので、文字列にしてから調べる
      const text = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(text).not.toContain("wrong-0");
      expect(text).not.toContain("pashiri-test-1234");
    } finally {
      await prisma.loginAttempt.deleteMany({ where: { email: "shop@example.com" } }); // 失敗しても、他のテストのためにロックを解除
    }
  });
  it("system ロールのユーザーは存在せず、ログインできない", async () => {
    expect(await prisma.userRole.count({ where: { role: "system" as never } }).catch(() => 0)).toBe(0);
  });
});

describe("他人の注文・自分の注文", () => {
  it("自分の注文を自分で引き受けることはできない（兼任ユーザー）", async () => {
    const both = await login("both@example.com");
    const orderId = await placeOrder(both, [{ productId: "p-komugi-1", qty: 1 }]);
    // 近くの注文一覧に自分の注文は出ない
    const nearby = await call(both, "GET", "/api/runner/orders/nearby");
    const ids = nearby.data.shops.flatMap((s: any) => s.orders.map((o: any) => o.id));
    expect(ids).not.toContain(orderId);
    // 直接 ID を指定しても引き受けられない
    const r = await call(both, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } });
    expect(r.status).toBe(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("placed");
    // 他のパシリなら引き受けられる
    const runner = await login("runner@example.com");
    const ok = await call(runner, "POST", "/api/runner/runs/preview", { body: { orderIds: [orderId] } });
    expect(ok.status).toBe(200);
    await call(both, "POST", `/api/customer/orders/${orderId}/cancel`, { body: {} });
  });

  it("他人の注文は見えない・操作できない（存在も教えない＝404）", async () => {
    const taro = await login("customer@example.com");
    const hanako = await login("customer2@example.com");
    const orderId = await placeOrder(taro, [{ productId: "p-komugi-2", qty: 1 }]);
    expect((await call(hanako, "GET", `/api/customer/orders/${orderId}`)).status).toBe(404);
    expect((await call(hanako, "POST", `/api/customer/orders/${orderId}/cancel`, { body: {} })).status).toBe(404);
    expect((await call(hanako, "POST", `/api/customer/orders/${orderId}/receive`, { body: {} })).status).toBe(404);
    const list = await call(hanako, "GET", "/api/customer/orders");
    expect(list.data.map((o: any) => o.id)).not.toContain(orderId);
    // 担当していないパシリも操作できない
    const runner = await login("runner@example.com");
    expect((await call(runner, "POST", `/api/runner/orders/${orderId}/deliver`, { body: {} })).status).toBe(404);
    // 本人は見える
    expect((await call(taro, "GET", `/api/customer/orders/${orderId}`)).status).toBe(200);
    await call(taro, "POST", `/api/customer/orders/${orderId}/cancel`, { body: {} });
  });

  it("他のパシリのおつかいは操作できない", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const both = await login("both@example.com");
    const orderId = await placeOrder(taro, [{ productId: "p-komugi-3", qty: 1 }]);
    const run = await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } });
    expect(run.status).toBe(200);
    expect((await call(both, "GET", `/api/runner/runs/${run.data.id}`)).status).toBe(404);
    expect((await call(both, "POST", `/api/runner/runs/${run.data.id}/receipt`, { form: await receiptForm(run.data.id) })).status).toBe(404);
    expect((await call(both, "POST", `/api/runner/runs/${run.data.id}/withdraw`, { body: {} })).status).toBe(404);
    // 同じ注文を二重に引き受けることもできない
    expect((await call(both, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } })).status).toBe(409);
    expect((await call(runner, "POST", `/api/runner/runs/${run.data.id}/withdraw`, { body: {} })).status).toBe(200);
    await call(taro, "POST", `/api/customer/orders/${orderId}/cancel`, { body: {} });
  });

  it("不正な状態遷移は拒否（引き受け前に「届けた」など）", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const orderId = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    const run = await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } });
    // レシート登録前に「届けた」
    const r = await call(runner, "POST", `/api/runner/orders/${orderId}/deliver`, { body: {} });
    expect(r.status).toBe(409);
    // お客さんが受け取り（まだ届いていない）
    expect((await call(taro, "POST", `/api/customer/orders/${orderId}/receive`, { body: {} })).status).toBe(409);
    await call(runner, "POST", `/api/runner/runs/${run.data.id}/withdraw`, { body: {} });
    await call(taro, "POST", `/api/customer/orders/${orderId}/cancel`, { body: {} });
  });
});

describe("見せてよい情報の制限（出口側）", () => {
  it("パシリには、配達中だけ電話番号・住所が見え、完了後は見えない。パスワードなどは一切出ない", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const orderId = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 2 }]);
    const run = (await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } })).data;
    const before = await call(runner, "GET", `/api/runner/runs/${run.id}`);
    expect(before.data.orders[0].customer).toEqual({ displayName: "たろう" });
    expect(before.text).not.toContain("passwordHash");
    expect(before.text).not.toContain("receiveCode");

    await call(runner, "POST", `/api/runner/runs/${run.id}/receipt`, { form: await receiptForm(run.id) });
    const during = await call(runner, "GET", `/api/runner/runs/${run.id}`);
    expect(during.data.orders[0].customer.phone).toBe("090-0000-0001");
    expect(during.data.orders[0].customer.address).toContain("武蔵野市");

    await call(runner, "POST", `/api/runner/orders/${orderId}/deliver`, { body: {} });
    const after = await call(runner, "GET", `/api/runner/runs/${run.id}`);
    expect(after.data.orders[0].customer).toEqual({ displayName: "たろう" });

    // お客さんにはパシリの表示名・評価だけ
    const mine = await call(taro, "GET", `/api/customer/orders/${orderId}`);
    expect(Object.keys(mine.data.runner).sort()).toEqual(["avgRating", "displayName", "ratingCount"]);
    expect(mine.text).not.toContain(runner.userId!);
    expect(mine.data.receiveCode).toMatch(/^\d{6}$/);
    await call(taro, "POST", `/api/customer/orders/${orderId}/receive`, { body: {} });
  });

  it("お店の集計に個人情報は含まれない", async () => {
    const shop = await login("shop@example.com");
    const r = await call(shop, "GET", "/api/shop/stats");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/customer|displayName|phone|address|email/i);
    const csv = await call(shop, "GET", "/api/shop/stats.csv");
    expect(csv.status).toBe(200);
    expect(csv.text).not.toMatch(/たろう|090-/);
  });

  it("admin でも個人情報は理由なしでは見られない。理由は記録に残る", async () => {
    const admin = await login("admin@example.com");
    const u = await prisma.user.findUniqueOrThrow({ where: { email: "customer@example.com" } });
    expect((await call(admin, "GET", `/api/admin/users/${u.id}/pii`)).status).toBe(400);
    const ok = await call(admin, "GET", `/api/admin/users/${u.id}/pii?reason=${encodeURIComponent("配達トラブルの連絡")}`);
    expect(ok.status).toBe(200);
    expect(ok.data.phone).toBe("090-0000-0001");
    const a = await lastAudit("api.admin.users.pii");
    expect(a).toMatchObject({ result: "allow", target: `user:${u.id}` });
    expect((a!.detail as any).reason).toBe("配達トラブルの連絡");
    // 注文一覧・詳細には個人情報が出ない
    const list = await call(admin, "GET", "/api/admin/orders");
    expect(list.text).not.toMatch(/090-0000|武蔵野市吉祥寺本町3/);
  });
});

describe("レシート画像", () => {
  it("期限付き URL でのみ見られる。他人は見られない", async () => {
    const taro = await login("customer@example.com");
    const hanako = await login("customer2@example.com");
    const runner = await login("runner@example.com");
    const orderId = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    const run = (await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } })).data;
    await call(runner, "POST", `/api/runner/runs/${run.id}/receipt`, { form: await receiptForm(run.id) });
    const url: string = (await call(taro, "GET", `/api/customer/orders/${orderId}`)).data.receiptUrl;
    expect(url).toMatch(/^\/api\/files\/receipts\/.+\?exp=\d+&sig=/);
    const ok = await call(taro, "GET", url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    // 署名なし・改ざん
    const bare = url.split("?")[0];
    expect((await call(taro, "GET", bare)).status).toBe(400);
    expect((await call(taro, "GET", url.replace(/sig=./, "sig=X"))).status).toBe(403);
    // 他人は、URL を知っていても見られない
    expect((await call(hanako, "GET", url)).status).toBe(404);
    expect((await call(anonymous(), "GET", url)).status).toBe(401);
    await call(runner, "POST", `/api/runner/orders/${orderId}/deliver`, { body: {} });
    await call(taro, "POST", `/api/customer/orders/${orderId}/receive`, { body: {} });
  });
  it("画像でないファイルは受け付けない", async () => {
    const taro = await login("customer@example.com");
    const runner = await login("runner@example.com");
    const orderId = await placeOrder(taro, [{ productId: "p-komugi-1", qty: 1 }]);
    const run = (await call(runner, "POST", "/api/runner/runs", { body: { orderIds: [orderId] } })).data;
    const fd = await receiptForm(run.id);
    fd.set("receipt", new Blob(["<script>alert(1)</script>"], { type: "image/png" }), "evil.png");
    const r = await call(runner, "POST", `/api/runner/runs/${run.id}/receipt`, { form: fd });
    expect(r.status).toBe(400);
    await call(runner, "POST", `/api/runner/runs/${run.id}/withdraw`, { body: {} });
    await call(taro, "POST", `/api/customer/orders/${orderId}/cancel`, { body: {} });
  });
});

describe("Webhook", () => {
  it("署名がない・違う Webhook は拒否", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "authorized", intentId: "x" });
    expect((await call(anonymous(), "POST", "/api/webhooks/stripe", { raw: body, noCsrf: true, origin: null })).status).toBe(400);
    expect((await call(anonymous(), "POST", "/api/webhooks/stripe", { raw: body, noCsrf: true, origin: null, headers: { "x-mock-signature": "bad" } })).status).toBe(400);
  });
});
