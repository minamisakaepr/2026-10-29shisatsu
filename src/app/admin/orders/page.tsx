"use client";
import { useCallback, useEffect, useState } from "react";
import { api, dt, STATUS_LABEL, yen } from "@/lib/api";

interface Row { id: string; status: string; shopName: string; customerId: string; runnerId: string | null; estimatedTotalJpy: number; finalTotalJpy: number | null; approvalStatus: string; paymentStatus: string | null; createdAt: string }
interface Dispute { id: string; orderId: string; status: string; reason: string; openedByRole: string; fromStatus: string; createdAt: string; resolution: string | null }
interface Detail { id: string; settingsSnapshot: unknown; transitions: { from: string; to: string; actorRole: string; actorId: string | null; reason: string; at: string }[]; payments: { id: string; status: string; amountAuthorizedJpy: number; amountCapturedJpy: number }[]; payout: { status: string; amountJpy: number } | null; receiptUrl: string | null; customerId: string; runnerId: string | null }
interface Pii { email: string; displayName: string; phone: string | null; address: string | null }

export default function AdminOrders() {
  const [rows, setRows] = useState<Row[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pii, setPii] = useState<Pii | null>(null);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await api<Row[]>(`/api/admin/orders${status ? `?status=${status}` : ""}`));
      setDisputes(await api<Dispute[]>("/api/admin/disputes"));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  async function resolve(d: Dispute, resolution: "complete" | "cancel") {
    const reason = prompt(resolution === "complete" ? "本決済して完了にする理由" : "キャンセル（仮押さえを解放）する理由");
    if (!reason) return;
    try {
      await api(`/api/admin/disputes/${d.id}/resolve`, { body: { resolution, reason } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function showPii(userId: string) {
    const reason = prompt("個人情報を見る理由を入力してください（記録に残ります）");
    if (!reason) return;
    try {
      setPii(await api<Pii>(`/api/admin/users/${userId}/pii?reason=${encodeURIComponent(reason)}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function refund(orderId: string) {
    const reason = prompt("返金する理由（パシリへの送金前に限り可能）");
    if (!reason) return;
    try {
      await api(`/api/admin/orders/${orderId}/refund`, { body: { reason } });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <h1>注文・トラブル対応</h1>
      {err && <div className="msg error">{err}</div>}
      <h2>トラブル申告</h2>
      {disputes.filter((d) => d.status === "open").length === 0 && <p className="muted small">未解決の申告はありません</p>}
      {disputes.filter((d) => d.status === "open").map((d) => (
        <div key={d.id} className="card stack small">
          <div><span className="badge bad">{d.openedByRole}</span> {d.reason}</div>
          <div className="muted">注文 <span className="code">{d.orderId}</span>（{STATUS_LABEL[d.fromStatus]} のとき）・{dt(d.createdAt)}</div>
          <div className="row">
            <button className="small" onClick={() => resolve(d, "complete")}>本決済して完了</button>
            <button className="small danger" onClick={() => resolve(d, "cancel")}>キャンセル（解放）</button>
          </div>
        </div>
      ))}

      <h2>注文</h2>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態で絞り込む">
        <option value="">すべての状態</option>
        {Object.keys(STATUS_LABEL).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <div className="card scroll-x">
        <table>
          <thead><tr><th>日時</th><th>店</th><th>状態</th><th>金額</th><th>決済</th><th></th></tr></thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td className="small">{dt(o.createdAt)}</td>
                <td>{o.shopName}</td>
                <td className="small">{STATUS_LABEL[o.status]}{o.approvalStatus === "pending" && "（承認待ち）"}</td>
                <td>{yen(o.finalTotalJpy ?? o.estimatedTotalJpy)}</td>
                <td className="small">{o.paymentStatus}</td>
                <td><button className="secondary small" onClick={async () => { setPii(null); setDetail(await api<Detail>(`/api/admin/orders/${o.id}`)); }}>詳細</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="card stack small">
          <div className="between"><strong className="code">{detail.id}</strong><button className="secondary small" onClick={() => setDetail(null)}>閉じる</button></div>
          <div className="row">
            <button className="secondary small" onClick={() => showPii(detail.customerId)}>お客さんの連絡先を見る（理由必須）</button>
            {detail.runnerId && <button className="secondary small" onClick={() => showPii(detail.runnerId!)}>パシリの連絡先を見る（理由必須）</button>}
            {detail.payout?.status === "scheduled" && <button className="danger small" onClick={() => refund(detail.id)}>返金する</button>}
          </div>
          {pii && <div className="msg info">{pii.displayName}・{pii.email}・{pii.phone ?? "電話なし"}・{pii.address ?? "住所なし"}</div>}
          {detail.receiptUrl && <a href={detail.receiptUrl} target="_blank" rel="noreferrer">レシート画像</a>}
          <strong>状態の記録</strong>
          {detail.transitions.map((t, i) => <div key={i}>{dt(t.at)}　{t.from} → {t.to}　<span className="muted">{t.actorRole} {t.actorId ?? ""}　{t.reason}</span></div>)}
          <strong>決済</strong>
          {detail.payments.map((p) => <div key={p.id} className="code">{p.status} 仮押さえ {p.amountAuthorizedJpy} / 本決済 {p.amountCapturedJpy}</div>)}
          {detail.payout && <div>送金：{detail.payout.status} {yen(detail.payout.amountJpy)}</div>}
          <details><summary>注文時点の設定値（スナップショット）</summary><pre className="code">{JSON.stringify(detail.settingsSnapshot, null, 2)}</pre></details>
        </div>
      )}
    </>
  );
}
