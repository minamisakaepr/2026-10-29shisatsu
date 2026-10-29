// テスト用データ（パスワードが公開されたテストユーザー）を入れてよいかの判定。
// インターネットに公開したアプリにテストユーザーが入る（＝だれでも管理者になれる）のを防ぐ。

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const LIVE_KEY = /^(sk|rk|pk)_live_/;

/**
 * 次がすべてそろったときだけ true。
 *  ・SEED_TEST_DATA=true と明示されている
 *  ・APP_URL が自分の PC（localhost など）
 *  ・Stripe の本番キーが入っていない
 * 明示されているのに条件を満たさないときは、エラーで止める（気づかずに進まないように）。
 */
export function testDataAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SEED_TEST_DATA !== "true") return false;
  const host = new URL(env.APP_URL ?? "http://localhost:3000").hostname;
  if (!LOCAL_HOSTS.includes(host) && !host.endsWith(".localhost")) {
    throw new Error(
      `APP_URL が自分の PC ではありません（${host}）。公開する環境にテストユーザーは入れられません。SEED_TEST_DATA=false にしてください。`,
    );
  }
  if ([env.STRIPE_SECRET_KEY, env.STRIPE_PUBLISHABLE_KEY].some((k) => LIVE_KEY.test(k ?? ""))) {
    throw new Error("Stripe の本番キーが入っています。テストユーザーは入れられません。SEED_TEST_DATA=false にしてください。");
  }
  return true;
}
