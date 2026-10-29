"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Cell { ops: string[]; scope: string; fields: unknown[]; reason: string }
interface Ledger { roles: string[]; rows: { id: string; kind: string; method: string | null; path: string | null; resource: string | null; requireReason: boolean; cells: Record<string, Cell | null> }[] }

export default function LedgerPage() {
  const [l, setL] = useState<Ledger | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Ledger>("/api/admin/access-ledger").then(setL).catch((e) => setErr(e.message));
  }, []);
  const rows = l?.rows.filter((r) => !q || `${r.id} ${r.path}`.includes(q)) ?? [];
  return (
    <>
      <h1>アクセス台帳</h1>
      <p className="muted small">全ロール × 全出入り口の一覧です。空欄（✕）は拒否。変更は <span className="code">security/access_ledger.yaml</span> をコードレビュー経由で行います（この画面からは変えられません）。</p>
      {err && <div className="msg error">{err}</div>}
      <input placeholder="絞り込み（例：runner、/api/admin）" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card scroll-x">
        <table>
          <thead><tr><th>出入り口</th>{l?.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="code">{r.id}</div>
                  <div className="muted small">{r.kind} {r.method} {r.path}{r.requireReason && " ・理由必須"}</div>
                </td>
                {l!.roles.map((role) => {
                  const c = r.cells[role];
                  return (
                    <td key={role} className="small" title={c ? `${c.reason}\n見せてよい項目: ${JSON.stringify(c.fields)}` : "拒否"}>
                      {c ? <><span className="badge ok">{c.ops.join("/")}</span><div>{c.scope}</div><div className="muted">{c.reason}</div></> : <span className="muted">✕</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
