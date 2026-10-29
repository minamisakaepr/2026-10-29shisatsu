// 門番（定期処理用）。定期処理は system ロールで動き、台帳の job.* に載っているものだけ実行できる。
import { appendAudit } from "./audit";
import { findGrant, getLedger } from "./ledger";
import { SYSTEM } from "./session";

export type JobFn = () => Promise<Record<string, unknown>>;

let jobs: Map<string, JobFn> | null = null;

export function setJobs(map: Record<string, JobFn>) {
  jobs = new Map(Object.entries(map));
}

export function jobIds(): string[] {
  return [...(jobs?.keys() ?? [])];
}

/** 定期処理を1回実行する。triggeredBy は admin が手動で動かしたときのユーザー ID */
export async function runJob(id: string, triggeredBy: string | null = null) {
  const entrance = getLedger().byId.get(id);
  const fn = jobs?.get(id);
  if (!entrance || entrance.kind !== "job" || !fn || !findGrant(entrance, SYSTEM.roles)) {
    await appendAudit({ userId: null, role: "system", entrance: id, operation: "update", result: "deny", detail: { why: "台帳にない定期処理", triggeredBy } });
    throw new Error(`定期処理 ${id} は台帳にありません`);
  }
  try {
    const result = await fn();
    await appendAudit({ userId: null, role: "system", entrance: id, operation: entrance.grants[0].ops[0], result: "allow", detail: { ...result, triggeredBy } });
    return result;
  } catch (err) {
    await appendAudit({ userId: null, role: "system", entrance: id, operation: entrance.grants[0].ops[0], result: "error", detail: { why: err instanceof Error ? err.message : String(err), triggeredBy } });
    throw err;
  }
}
