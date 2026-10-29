// サーバー・ワーカー共通の起動処理。台帳とコードがずれていたら、ここで止める。
import { loadEnv } from "./env";
import { setRegistry } from "./gate/dispatch";
import { jobIds } from "./gate/jobs";
import { checkStartup } from "./gate/startupCheck";
import { ALL_ENDPOINTS } from "./endpoints";
import { registerJobs } from "./jobs";

let booted = false;

export function boot(opts: { appDir?: string } = {}) {
  if (booted) return;
  loadEnv(); // 本番キーの誤投入などをここで検出
  setRegistry(ALL_ENDPOINTS);
  registerJobs();
  const problems = checkStartup({ endpoints: ALL_ENDPOINTS, jobIds: jobIds(), appDir: opts.appDir });
  if (problems.length) {
    throw new Error(`起動時チェックに失敗しました（アクセス台帳とコードがずれています）:\n- ${problems.join("\n- ")}`);
  }
  booted = true;
}
