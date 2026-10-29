"use client";
import { useEffect, useState } from "react";
import { api, dt, yen } from "@/lib/api";

interface Journal { seq: string; id: string; eventType: string; orderId: string | null; amountJpy: number; stripeRef: string | null; memo: string; createdAt: string; lines: { account: string; debitJpy: number; creditJpy: number }[] }
interface Recon { id: string; at: string; status: string; checked: number; details: unknown[] }

const EVENT: Record<string, string> = { hold: "仮押さえ", release: "解放", capture: "本決済", fee: "手数料", payout: "パシリへ送金", refund: "返金" };

export default function MoneyPage() {
  const [data, setData] = useState<{ balances: Record<string, number>; journals: Journal[] } | null>(null);
  const [recons, setRecons] = useState<Recon[]>([]);
  const [err, setErr] = useState("");
  const load = () => Promise.all([api("/api/admin/money"), api<Recon[]>("/api/admin/reconciliations")]).then(([m, r]) => { setData(m); setRecons(r); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <h1>お金の台帳</h1>
      {err && <div className="msg error">{err}</div>}
      <div className="card small">
        <strong>勘定科目ごとの残高（借方 − 貸方）</strong>
        {data && Object.entries(data.balances).map(([k, v]) => <div key={k} className="between"><span className="code">{k}</span><span>{yen(v)}</span></div>)}
        <p><button className="secondary small" onClick={() => {
          const r = prompt("書き出す理由を入力してください（記録に残ります）");
          if (r) window.location.href = `/api/admin/money.csv?reason=${encodeURIComponent(r)}`;
        }}>CSV で書き出す</button></p>
      </div>
      <h2>Stripe との照合</h2>
      <div className="card small">
        <button className="secondary small" onClick={async () => { await api("/api/admin/jobs/reconcile/run", { body: {} }); load(); }}>いま照合する</button>
        {recons.map((r) => (
          <div key={r.id} className="between">
            <span>{dt(r.at)}</span>
            <span className={`badge ${r.status === "ok" ? "ok" : "bad"}`}>{r.status === "ok" ? "差異なし" : `差異 ${r.details.length}件`}</span>
            <span className="muted">{r.checked}件確認</span>
          </div>
        ))}
        {recons.filter((r) => r.status !== "ok").slice(0, 1).map((r) => <pre key={r.id} className="code">{JSON.stringify(r.details, null, 2)}</pre>)}
      </div>
      <h2>仕訳</h2>
      <div className="card scroll-x">
        <table>
          <thead><tr><th>#</th><th>日時</th><th>イベント</th><th>金額</th><th>借方 / 貸方</th><th>注文</th></tr></thead>
          <tbody>
            {data?.journals.map((j) => (
              <tr key={j.id}>
                <td className="small">{j.seq}</td>
                <td className="small">{dt(j.createdAt)}</td>
                <td>{EVENT[j.eventType] ?? j.eventType}<div className="muted small">{j.memo}</div></td>
                <td>{yen(j.amountJpy)}</td>
                <td className="code">{j.lines.map((l, i) => <div key={i}>{l.debitJpy ? `借 ${l.account} ${l.debitJpy}` : `　貸 ${l.account} ${l.creditJpy}`}</div>)}</td>
                <td className="code small">{j.orderId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
