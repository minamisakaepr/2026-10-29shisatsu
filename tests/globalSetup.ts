// 結合テストの前に、テスト専用 DB を空にしてマイグレーションと初期データを入れ直す。
// 単体テストだけ動かすとき（npm run test:unit）は DB に触らない。
import { execSync } from "node:child_process";

export default async function setup() {
  const onlyUnit = process.argv.some((a) => a.includes("tests/unit"));
  if (onlyUnit) return;
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://pashiri:pashiri@localhost:5432/pashiri_test?schema=public";
  // 安全装置：テスト専用 DB（名前が _test で終わる）以外は絶対に作り直さない
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`テスト用 DB の名前は _test で終わる必要があります（いま: ${dbName}）`);
  const env = { ...process.env, DATABASE_URL: url, PAYMENT_MODE: "mock", APP_URL: "http://localhost:3000", SEED_TEST_DATA: "true", APP_SECRET: "test-secret-0123456789abcdef0123456789abcdef", STORAGE_DIR: "./storage-test" };
  // 追記専用の台帳は TRUNCATE できないので、スキーマごと作り直す
  execSync("npx prisma migrate reset --force --skip-seed --skip-generate", { env, stdio: "inherit" });
  execSync("npx tsx prisma/seed.ts", { env, stdio: "inherit" });
}
