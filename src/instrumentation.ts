// サーバー起動時に1回だけ動く。アクセス台帳とコードがずれていたら、サーバーを止める。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { boot } = await import("./server/boot");
  try {
    boot();
    console.log("[起動時チェック] アクセス台帳とコードは一致しています");
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
