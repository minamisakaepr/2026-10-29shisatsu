// 定期処理ワーカー（system ロール）。設定値 job_interval_seconds ごとに定期処理を動かす。
// 起動: npm run worker（Docker Compose では自動で起動）
import "dotenv/config";
import { boot } from "./server/boot";
import { runJob } from "./server/gate/jobs";
import { reconcileDue } from "./server/jobs";
import { resolveSettings } from "./server/settings/service";

const EVERY_TICK = ["job.expire_orders", "job.auto_complete", "job.retry_captures", "job.payouts"];
// 失敗が続いたときに待つ時間（設定値が読めないときの安全策）
const RETRY_WAIT_MS = 10_000;

async function tick() {
  for (const id of EVERY_TICK) {
    try {
      const r = await runJob(id);
      if ((r as { ok?: number }).ok) console.log(`[worker] ${id}`, r);
    } catch (e) {
      console.error(`[worker] ${id} でエラー`, e);
    }
  }
  // 照合は1日1回
  if (await reconcileDue()) console.log("[worker] job.reconcile", await runJob("job.reconcile"));
}

async function loop() {
  for (;;) {
    try {
      await tick();
      const s = await resolveSettings();
      await new Promise((r) => setTimeout(r, s.job_interval_seconds * 1000));
    } catch (e) {
      console.error("[worker] エラー", e);
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
}

boot();
console.log("[worker] 定期処理ワーカーを起動しました");
void loop();
