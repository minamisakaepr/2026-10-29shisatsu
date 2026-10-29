"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, dt } from "@/lib/api";

interface Note { id: string; kind: string; message: string; createdAt: string }

export default function AdminHome() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api<Note[]>("/api/admin/notifications").then(setNotes).catch(() => {});
  }, []);
  async function run(name: string) {
    setMsg("");
    try {
      const r = await api(`/api/admin/jobs/${name}/run`, { body: {} });
      setMsg(`${name}: ${JSON.stringify(r.result)}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <>
      <h1>運営メニュー</h1>
      <div className="card stack">
        <Link href="/admin/settings">設定値の管理（履歴・差し戻し）</Link>
        <Link href="/admin/orders">注文・トラブル対応</Link>
        <Link href="/admin/money">お金の台帳・Stripe との照合</Link>
        <Link href="/admin/audit">通行記録の検索・異常検知</Link>
        <Link href="/admin/ledger">アクセス台帳（だれに何を許しているか）</Link>
      </div>
      <h2>定期処理をすぐ動かす</h2>
      <div className="card row">
        {["expire_orders", "auto_complete", "retry_captures", "payouts", "reconcile"].map((n) => (
          <button key={n} className="secondary small" onClick={() => run(n)}>{n}</button>
        ))}
        {msg && <div className="msg info code" style={{ width: "100%" }}>{msg}</div>}
      </div>
      <h2>運営あての通知</h2>
      {notes.length === 0 && <p className="muted small">通知はありません</p>}
      {notes.map((n) => <div key={n.id} className="card small"><span className="badge">{n.kind}</span> {n.message}<div className="muted">{dt(n.createdAt)}</div></div>)}
    </>
  );
}
