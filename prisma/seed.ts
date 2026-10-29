// 初期データの投入（何回実行しても同じ状態になる）
//  ・設定値の初期値（config/settings.default.yaml）… いつも入れる
//  ・テスト用データ … SEED_TEST_DATA=true で、しかも自分の PC（localhost）で動かすときだけ入れる
//      エリア / 店 / 商品 / パシリ特典
//      各ロールのテストユーザー（パスワードは下の TEST_PASSWORD。公開されているので本番では絶対に使わない）
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient, type Role } from "@prisma/client";
import { seedDefaults } from "../src/server/settings/service";
import { gateway } from "../src/server/payments";
import { testDataAllowed } from "../src/server/lib/seedGuard";

const prisma = new PrismaClient();

export const TEST_PASSWORD = "pashiri-test-1234";

// 吉祥寺駅のあたり（架空の店・人）
const AREA = { id: "area-kichijoji", name: "吉祥寺エリア" };
const SHOPS = [
  {
    id: "shop-komugi", name: "こむぎ堂", address: "東京都武蔵野市吉祥寺本町1-1（架空）", lat: 35.7033, lng: 139.5797,
    products: [
      ["p-komugi-1", "塩バターロール", 180], ["p-komugi-2", "クロワッサン", 260], ["p-komugi-3", "あんぱん", 200],
      ["p-komugi-4", "食パン（1斤）", 420], ["p-komugi-5", "カレーパン", 280],
    ],
    perks: [["パシリさんにはコーヒー1杯サービス", "レジで「パシリです」と伝えてください"]],
  },
  {
    id: "shop-hinata", name: "ひなたベーカリー", address: "東京都武蔵野市吉祥寺南町2-2（架空）", lat: 35.7010, lng: 139.5823,
    products: [["p-hinata-1", "メロンパン", 220], ["p-hinata-2", "ベーグル", 240], ["p-hinata-3", "バゲット", 380]],
    perks: [["パシリさん専用の受け取り棚あり", "店の右奥の棚に、まとめて用意しておきます"]],
  },
] as const;

const USERS: { email: string; name: string; roles: Role[]; lat: number; lng: number; phone?: string; address?: string; shops?: string[]; runnerAccount?: boolean }[] = [
  { email: "admin@example.com", name: "運営さん", roles: ["admin"], lat: 35.7029, lng: 139.5800 },
  { email: "shop@example.com", name: "こむぎ堂の店長", roles: ["shop"], lat: 35.7033, lng: 139.5797, shops: ["shop-komugi", "shop-hinata"] },
  { email: "customer@example.com", name: "たろう", roles: ["customer"], lat: 35.7060, lng: 139.5760, phone: "090-0000-0001", address: "武蔵野市吉祥寺本町3-3-3（架空）" },
  { email: "customer2@example.com", name: "はなこ", roles: ["customer"], lat: 35.6995, lng: 139.5850, phone: "090-0000-0002", address: "武蔵野市吉祥寺南町4-4-4（架空）" },
  { email: "runner@example.com", name: "はしるくん", roles: ["runner"], lat: 35.7025, lng: 139.5805, runnerAccount: true },
  // お客さんとパシリを兼ねる人（自分の注文は引き受けられないことの確認用）
  { email: "both@example.com", name: "かねるさん", roles: ["customer", "runner"], lat: 35.7040, lng: 139.5790, phone: "090-0000-0003", address: "武蔵野市吉祥寺本町5-5-5（架空）", runnerAccount: true },
];

async function main() {
  await seedDefaults(prisma);
  if (!testDataAllowed()) {
    console.log("設定値の初期値を入れました（テスト用データは入れていません。入れるときは SEED_TEST_DATA=true）");
    return;
  }
  await prisma.area.upsert({ where: { id: AREA.id }, create: AREA, update: { name: AREA.name } });
  for (const s of SHOPS) {
    await prisma.shop.upsert({
      where: { id: s.id },
      create: { id: s.id, areaId: AREA.id, name: s.name, address: s.address, lat: s.lat, lng: s.lng },
      update: {},
    });
    for (const [i, [id, name, price]] of s.products.entries()) {
      await prisma.product.upsert({ where: { id }, create: { id, shopId: s.id, name, priceJpy: price, sortOrder: i }, update: {} });
    }
    for (const [i, [title, description]] of s.perks.entries()) {
      const id = `${s.id}-perk-${i}`;
      await prisma.runnerPerk.upsert({ where: { id }, create: { id, shopId: s.id, title, description }, update: {} });
    }
  }

  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email, passwordHash: hash, displayName: u.name, lat: u.lat, lng: u.lng, phone: u.phone, address: u.address,
        emailVerifiedAt: new Date(), roles: { create: u.roles.map((role) => ({ role })) },
      },
      update: {},
    });
    for (const shopId of u.shops ?? []) {
      await prisma.shopMember.upsert({ where: { userId_shopId: { userId: user.id, shopId } }, create: { userId: user.id, shopId }, update: {} });
    }
    // モック決済のときだけ、パシリの受け取り口座を登録済みにしておく（Stripe のときは画面から登録）
    if (u.runnerAccount && !user.stripeAccountId && gateway().mode === "mock") {
      const acct = await gateway().createConnectedAccount({ id: user.id, email: user.email }, `connect-account:${user.id}`);
      await prisma.user.update({ where: { id: user.id }, data: { stripeAccountId: acct, payoutsEnabled: true } });
    }
  }
  console.log(`テスト用データを投入しました。テストユーザーのパスワード: ${TEST_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
