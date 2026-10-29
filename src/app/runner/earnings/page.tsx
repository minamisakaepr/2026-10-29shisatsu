"use client";
import { useEffect, useState } from "react";
import { api, dt, yen } from "@/lib/api";

interface Earnings {
  totals: { paidJpy: number; scheduledJpy: number; runs: number };
  monthlyRuns: number; avgRating: number | null; ratingCount: number; titles: string[];
  payouts: { id: string; amountJpy: number; status: string; scheduledAt: string; paidAt: string | null }[];
  messages: { stars: number; message: string; at: string }[];
}
const PAYOUT_LABEL: Record<string, string> = { scheduled: "入金予定", paid: "入金済み", failed: "失敗", cancelled: "取り消し" };

export default function EarningsPage() {
  const [e, setE] = useState<Earnings | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Earnings>("/api/runner/earnings").then(setE).catch((x) => setErr(x.message));
  }, []);
  if (!e) return err ? <div className="msg error">{err}</div> : <p>読み込み中…</p>;
  return (
    <>
      <h1>報酬・入金</h1>
      <div className="card">
        <div className="between"><span>入金済み</span><strong>{yen(e.totals.paidJpy)}</strong></div>
        <div className="between"><span>入金予定</span><span>{yen(e.totals.scheduledJpy)}</span></div>
        <div className="between"><span>おつかい（累計 / 今月）</span><span>{e.totals.runs}回 / {e.monthlyRuns}回</span></div>
        <div className="between"><span>評価</span><span>{e.avgRating ?? "—"}（{e.ratingCount}件）</span></div>
        <div className="row" style={{ marginTop: 8 }}>{e.titles.length ? e.titles.map((t) => <span key={t} className="badge ok">🏅 {t}</span>) : <span className="muted small">称号はまだありません</span>}</div>
      </div>
      <h2>ありがとうメッセージ</h2>
      {e.messages.length === 0 && <p className="muted small">まだありません</p>}
      {e.messages.map((m, i) => <div key={i} className="card small">{"★".repeat(m.stars)}　{m.message}<div className="muted">{dt(m.at)}</div></div>)}
      <h2>入金履歴</h2>
      <div className="card scroll-x">
        <table>
          <thead><tr><th>金額</th><th>状態</th><th>予定</th><th>入金</th></tr></thead>
          <tbody>{e.payouts.map((p) => <tr key={p.id}><td>{yen(p.amountJpy)}</td><td>{PAYOUT_LABEL[p.status]}</td><td>{dt(p.scheduledAt)}</td><td>{dt(p.paidAt)}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}
