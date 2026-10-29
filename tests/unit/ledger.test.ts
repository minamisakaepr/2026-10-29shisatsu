// アクセス台帳のテスト（DB なし）：台帳の形式チェック、デフォルト拒否、起動時チェック、見せてよい項目の絞り込み
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findGrant, getLedger, matchEntrance, parseLedger } from "@/server/gate/ledger";
import { project } from "@/server/gate/projection";
import { checkStartup, pageRoutes } from "@/server/gate/startupCheck";
import { ALL_ENDPOINTS } from "@/server/endpoints";
import { JOBS } from "@/server/jobs";
import { endpoint } from "@/server/gate/types";

const jobIds = Object.keys(JOBS);

describe("台帳の読み込み", () => {
  it("リポジトリの台帳は形式チェックに通る", () => {
    expect(() => getLedger()).not.toThrow();
    expect(getLedger().entrances.length).toBeGreaterThan(50);
  });

  it("おかしな台帳は読み込みで止まる", () => {
    const bad = (grants: string, extra = "kind: api\n    method: GET\n    path: /api/x") =>
      `version: 1\nentrances:\n  - id: api.x.y\n    ${extra}\n    grants:\n${grants}`;
    // customer に scope=all
    expect(() => parseLedger(bad("      - { role: customer, ops: [read], scope: all, fields: [id], reason: テスト }"))).toThrow(/scope=all/);
    // API なのに fields がない
    expect(() => parseLedger(bad("      - { role: admin, ops: [read], scope: all, reason: テスト }"))).toThrow(/fields/);
    // 理由がない
    expect(() => parseLedger(bad("      - { role: admin, ops: [read], scope: all, fields: [id] }"))).toThrow();
    // Webhook に署名検証がない
    expect(() => parseLedger(bad("      - { role: anonymous, ops: [create], scope: public, fields: [ok], reason: テスト }", "kind: webhook\n    method: POST\n    path: /api/hook"))).toThrow(/署名/);
    // GET なのに create しか許していない
    expect(() => parseLedger(bad("      - { role: admin, ops: [create], scope: all, fields: [id], reason: テスト }"))).toThrow(/ops/);
    // system ロールを API に
    expect(() => parseLedger(bad("      - { role: system, ops: [read], scope: all, fields: [id], reason: テスト }"))).toThrow(/system/);
    // 注文に "*"
    expect(() => parseLedger(bad("      - { role: admin, ops: [read], scope: all, fields: [\"*\"], reason: テスト }", "kind: api\n    method: GET\n    path: /api/x\n    resource: order"))).toThrow(/\*/);
  });
});

describe("デフォルト拒否", () => {
  const ledger = () => getLedger();
  it("台帳にないパスは出入り口が見つからない", () => {
    expect(matchEntrance(ledger(), ["api"], "GET", "/api/secret/dump")).toBeNull();
    expect(matchEntrance(ledger(), ["api"], "DELETE", "/api/customer/orders/abc")).toBeNull(); // メソッド違い
    expect(matchEntrance(ledger(), ["page"], null, "/admin/secret")).toBeNull();
  });
  it("台帳にないロールは許可行が見つからない", () => {
    const e = matchEntrance(ledger(), ["api"], "GET", "/api/admin/settings")!.entrance;
    expect(findGrant(e, ["customer", "runner", "shop"], "GET")).toBeNull();
    expect(findGrant(e, ["anonymous"], "GET")).toBeNull();
    expect(findGrant(e, ["admin"], "GET")?.role).toBe("admin");
  });
  it("パシリはお客さんの API を使えない（兼任していなければ）", () => {
    const e = matchEntrance(ledger(), ["api"], "POST", "/api/customer/orders")!.entrance;
    expect(findGrant(e, ["runner"], "POST")).toBeNull();
  });
  it("定期処理は system だけ。HTTP からは見えない", () => {
    expect(ledger().entrances.filter((e) => e.kind === "job").every((e) => e.grants.every((g) => g.role === "system"))).toBe(true);
    expect(matchEntrance(ledger(), ["api", "webhook", "file", "export"], "POST", "/api/jobs/payouts")).toBeNull();
  });
});

describe("起動時チェック", () => {
  it("いまのコードと台帳は一致している", () => {
    expect(checkStartup({ endpoints: ALL_ENDPOINTS, jobIds })).toEqual([]);
  });
  it("台帳にない API 処理を足すと失敗する", () => {
    const extra = endpoint({ id: "api.hidden.backdoor", handler: async () => ({}) });
    expect(checkStartup({ endpoints: [...ALL_ENDPOINTS, extra], jobIds })).toContain("API 処理 api.hidden.backdoor が台帳にありません");
  });
  it("台帳にある処理を消すと失敗する", () => {
    const problems = checkStartup({ endpoints: ALL_ENDPOINTS.filter((e) => e.id !== "api.customer.orders.cancel"), jobIds });
    expect(problems).toContain("台帳の api.customer.orders.cancel に処理がありません");
  });
  it("台帳にない定期処理は失敗する", () => {
    expect(checkStartup({ endpoints: ALL_ENDPOINTS, jobIds: [...jobIds, "job.secret"] })).toContain("定期処理 job.secret が台帳にありません");
  });

  describe("画面と API ファイル", () => {
    let appDir = "";
    beforeAll(() => {
      appDir = mkdtempSync(path.join(os.tmpdir(), "pashiri-app-"));
      const real = path.join(process.cwd(), "src", "app");
      for (const r of pageRoutes(real)) {
        const dir = path.join(appDir, ...r.split("/").filter(Boolean).map((s) => (s.startsWith(":") ? `[${s.slice(1)}]` : s)));
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "page.tsx"), "");
      }
      mkdirSync(path.join(appDir, "api", "[...path]"), { recursive: true });
      writeFileSync(path.join(appDir, "api", "[...path]", "route.ts"), "");
    });
    it("コピーした構成なら OK", () => {
      expect(checkStartup({ endpoints: ALL_ENDPOINTS, jobIds, appDir })).toEqual([]);
    });
    it("台帳にない画面を足すと失敗する", () => {
      mkdirSync(path.join(appDir, "secret"), { recursive: true });
      writeFileSync(path.join(appDir, "secret", "page.tsx"), "");
      expect(checkStartup({ endpoints: ALL_ENDPOINTS, jobIds, appDir })).toContain("画面 /secret が台帳にありません");
    });
    it("門番を通らない route.ts を足すと失敗する", () => {
      mkdirSync(path.join(appDir, "api", "raw"), { recursive: true });
      writeFileSync(path.join(appDir, "api", "raw", "route.ts"), "");
      expect(checkStartup({ endpoints: ALL_ENDPOINTS, jobIds, appDir }).some((p) => p.includes("api/raw/route.ts"))).toBe(true);
    });
  });
});

describe("見せてよい項目だけに絞る", () => {
  const runFields = getLedger().byId.get("api.runner.runs.show")!.grants[0].fields!;
  const run = {
    id: "r1",
    secretInternal: "見えてはいけない",
    orders: [
      { id: "o1", status: "matched", customer: { displayName: "たろう", phone: "090", address: "住所", email: "x@y", passwordHash: "h" }, items: [] },
      { id: "o2", status: "purchased", customer: { displayName: "はなこ", phone: "080", address: "住所2" }, items: [] },
      { id: "o3", status: "completed", customer: { displayName: "じろう", phone: "070", address: "住所3" }, items: [] },
    ],
  };
  const out = project(run, runFields) as any;
  it("台帳にない項目は消える", () => {
    expect(out.secretInternal).toBeUndefined();
    expect(out.orders[0].customer.email).toBeUndefined();
    expect(out.orders[0].customer.passwordHash).toBeUndefined();
  });
  it("電話番号・住所は配達中（purchased）の注文だけ。完了後は見えない", () => {
    expect(out.orders[0].customer).toEqual({ displayName: "たろう" });
    expect(out.orders[1].customer).toEqual({ displayName: "はなこ", phone: "080", address: "住所2" });
    expect(out.orders[2].customer).toEqual({ displayName: "じろう" });
  });
  it("お客さんの受け取りコードは purchased / delivered のときだけ", () => {
    const f = getLedger().byId.get("api.customer.orders.show")!.grants[0].fields!;
    expect((project({ status: "matched", receiveCode: "123456" }, f) as any).receiveCode).toBeUndefined();
    expect((project({ status: "delivered", receiveCode: "123456" }, f) as any).receiveCode).toBe("123456");
  });
  it("お店の集計に個人情報は出ない", () => {
    const f = getLedger().byId.get("api.shop.stats")!.grants[0].fields!;
    const o = project({ shops: [{ id: "s", name: "店", days: [{ date: "d", orders: 1, itemsJpy: 1, customerId: "u1" }], customers: ["u1"] }] }, f) as any;
    expect(o.shops[0].customers).toBeUndefined();
    expect(o.shops[0].days[0].customerId).toBeUndefined();
  });
  it("fields がなければ何も返さない", () => {
    expect(project({ a: 1 }, undefined)).toBeNull();
  });
});
