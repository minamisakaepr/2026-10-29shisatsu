"use client";
import { useCallback, useEffect, useState } from "react";
import { api, dt } from "@/lib/api";

interface Row { seq: string; at: string; userId: string | null; role: string; entrance: string; operation: string; target: string | null; result: string; ip: string | null; detail: unknown }
interface Anomalies { windowMinutes: number; threshold: number; users: { userId: string | null; denies: number }[]; ips: { ip: string | null; denies: number }[] }

export default function AuditPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [f, setF] = useState({ userId: "", entrance: "", result: "", ip: "", target: "" });
  const [an, setAn] = useState<Anomalies | null>(null);
  const [chain, setChain] = useState("");
  const [err, setErr] = useState("");

  const search = useCallback(async () => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    try {
      setRows(await api<Row[]>(`/api/admin/audit?${q}`));
      setAn(await api<Anomalies>("/api/admin/audit/anomalies"));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [f]);
  useEffect(() => { search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h1>通行記録</h1>
      <div className="card stack">
        <strong>異常検知（{an?.windowMinutes}分間に {an?.threshold}回以上の拒否）</strong>
        {an && an.users.length + an.ips.length === 0 && <span className="muted small">いまは異常はありません</span>}
        {an?.users.map((u) => <div key={String(u.userId)} className="badge bad">ユーザー {u.userId ?? "未ログイン"}：{u.denies}回</div>)}
        {an?.ips.map((u) => <div key={String(u.ip)} className="badge bad">IP {u.ip ?? "不明"}：{u.denies}回</div>)}
        <div className="row">
          <button className="secondary small" onClick={async () => {
            const r = await api<{ audit: { ok: boolean; checked: number; brokenAtSeq: string | null } }>("/api/admin/audit/verify");
            setChain(r.audit.ok ? `改ざんなし（${r.audit.checked}行を確認）` : `改ざんの疑い：seq ${r.audit.brokenAtSeq} で連鎖が切れています`);
          }}>改ざんチェック</button>
          {chain && <span className="small">{chain}</span>}
        </div>
      </div>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <input placeholder="ユーザーID" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} style={{ flex: 1 }} />
        <input placeholder="出入り口" value={f.entrance} onChange={(e) => setF({ ...f, entrance: e.target.value })} style={{ flex: 1 }} />
        <input placeholder="対象（order:... など）" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} style={{ flex: 1 }} />
        <input placeholder="IP" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} style={{ flex: 1 }} />
        <select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })} style={{ flex: 1 }} aria-label="結果">
          <option value="">すべての結果</option><option value="allow">許可</option><option value="deny">拒否</option><option value="error">エラー</option><option value="info">記録</option>
        </select>
        <button className="small">検索</button>
      </form>
      {err && <div className="msg error">{err}</div>}
      <div className="card scroll-x">
        <table>
          <thead><tr><th>#</th><th>日時</th><th>だれ</th><th>出入り口</th><th>対象</th><th>結果</th><th>IP</th><th>補足</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq}>
                <td className="small">{r.seq}</td>
                <td className="small">{dt(r.at)}</td>
                <td className="small">{r.role}<div className="code muted">{r.userId}</div></td>
                <td className="code">{r.entrance}<div className="muted">{r.operation}</div></td>
                <td className="code">{r.target}</td>
                <td><span className={`badge ${r.result === "allow" ? "ok" : r.result === "deny" || r.result === "error" ? "bad" : ""}`}>{r.result}</span></td>
                <td className="small">{r.ip}</td>
                <td className="code small">{JSON.stringify(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
