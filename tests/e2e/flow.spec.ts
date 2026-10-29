// 画面からの通しテスト（スマホ画面サイズ）：注文 → 引き受け → レシート → 配達 → 受け取りコード → 完了
import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "pashiri-test-1234";
// 1x1 の PNG（レシートの代わり）
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

async function loginAs(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(PASSWORD);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  return page;
}

test("ログインしていないと画面に入れず、権限のない画面は拒否される", async ({ page, browser }) => {
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin%2Fsettings/);
  const customer = await loginAs(browser, "customer@example.com");
  await customer.goto("/admin/settings");
  await expect(customer).toHaveURL(/\/forbidden/);
  const res = await customer.goto("/secret-page");
  expect(res?.status()).toBe(404);
});

test("注文から受け取り完了まで", async ({ browser }) => {
  const customer = await loginAs(browser, "customer@example.com");
  await customer.goto("/customer");
  await customer.getByRole("link", { name: "選ぶ" }).first().click();
  await customer.getByLabel("塩バターロールの個数").fill("2");
  await customer.getByLabel(/受け渡し場所/).fill("E2E テストの公園");
  await customer.getByRole("button", { name: "注文して仮押さえへ進む" }).click();
  await customer.getByRole("button", { name: /テストカードで支払う/ }).click();
  await expect(customer.locator(".badge", { hasText: "パシリを探しています" })).toBeVisible();
  const orderUrl = customer.url();

  const runner = await loginAs(browser, "runner@example.com");
  await runner.goto("/runner");
  await runner.locator("label", { hasText: "E2E テストの公園" }).last().locator("input[type=checkbox]").check();
  await runner.getByRole("button", { name: "まとめて引き受ける" }).click();
  await runner.waitForURL(/\/runner\/runs\//);
  await runner.getByLabel("レシートの写真").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await runner.getByRole("button", { name: "レシートを登録して配達へ" }).click();
  await runner.getByRole("button", { name: "届けた" }).click();

  await customer.goto(orderUrl);
  const code = (await customer.locator(".big-code").textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);

  await runner.reload();
  await runner.getByLabel("受け取りコード").fill(code);
  await Promise.all([
    runner.waitForResponse((r) => r.url().includes("/receive") && r.status() === 200),
    runner.getByRole("button", { name: "受け取り完了" }).click(),
  ]);

  await customer.reload();
  await expect(customer.locator(".badge", { hasText: /^完了$/ })).toBeVisible();
});
