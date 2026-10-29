"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PaymentStep, type PaymentInfo } from "@/components/PaymentStep";
import { QrImage } from "@/components/Qr";
import { api, dt, REASON_LABEL, STATUS_LABEL, yen } from "@/lib/api";

interface Item { id: string; name: string; qty: number; unitPriceJpy: number; actualUnitPriceJpy: number | null; actualQty: number | null; outOfStock: boolean; substitutionName: string | null }
interface Order {
  id: string; status: string; shop: { name: string }; items: Item[]; dropoffLabel: string; note: string;
  estimatedItemsJpy: number; estimatedDeliveryFeeJpy: number; estimatedPlatformFeeJpy: number; estimatedTotalJpy: number; holdAmountJpy: number;
  actualItemsJpy: number | null; deliveryFeeJpy: number | null; platformFeeJpy: number | null; finalTotalJpy: number | null;
  approvalStatus: string; approvalReasons: string[] | null; receiveCode?: string; runner: { displayName: string; avgRating: number | null; ratingCount: number } | null;
  receiptUrl: string | null; transitions: { from: string; to: string; at: string }[]; rating: { stars: number; message: string } | null;
  matchedAt: string | null; cancelDeadlineAt: string | null; autoCompleteAt: string | null; canCancel: boolean; paymentMode: string;
}

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState("");
  const [reauth, setReauth] = useState<PaymentInfo | null>(null);
  const [stars, setStars] = useState(5);
  const [message, setMessage] = useState("ありがとうございました！");
  const [disputeText, setDisputeText] = useState("");

  const load = useCallback(() => api<Order>(`/api/customer/orders/${id}`).then(setO).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000); // 進行状況を10秒ごとに更新
    return () => clearInterval(t);
  }, [load]);

  async function act(path: string, body: unknown = {}) {
    setErr("");
    try {
      const r = await api<{ payment?: PaymentInfo | null }>(`/api/customer/orders/${id}/${path}`, { body });
      if (r?.payment) setReauth(r.payment);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!o) return err ? <div className="msg error">{err}</div> : <p>読み込み中…</p>;

  return (
    <>
      <h1>{o.shop.name} の注文</h1>
      <div className="card">
        <span className={`badge ${o.status === "completed" ? "ok" : o.status === "disputed" ? "bad" : ""}`}>{STATUS_LABEL[o.status]}</span>
        {o.runner && <p>パシリ：<strong>{o.runner.displayName}</strong> <span className="muted small">（評価 {o.runner.avgRating ?? "—"} / {o.runner.ratingCount}件）</span></p>}
        <p className="muted small">受け渡し場所：{o.dropoffLabel}</p>
        {o.status === "draft" && <p className="msg info">仮押さえが終わっていません。</p>}
      </div>

      {err && <div className="msg error">{err}</div>}

      {o.status === "draft" && !reauth && (
        <PaymentRetry orderId={o.id} />
      )}

      {reauth && (
        <PaymentStep orderId={o.id} payment={reauth} amountLabel={yen(o.finalTotalJpy)} onDone={() => { setReauth(null); load(); }} />
      )}

      {o.status === "purchased" && o.approvalStatus === "pending" && !reauth && (
        <div className="card stack">
          <strong>承認をお願いします</strong>
          <ul>{(o.approvalReasons ?? []).map((r) => <li key={r}>{REASON_LABEL[r] ?? r}</li>)}</ul>
          <div>新しい合計：<strong>{yen(o.finalTotalJpy)}</strong>（見積 {yen(o.estimatedTotalJpy)}・仮押さえ {yen(o.holdAmountJpy)}）</div>
          <div className="row">
            <button onClick={() => act("approve", { decision: "approve" })}>承認する</button>
            <button className="danger" onClick={() => act("approve", { decision: "reject", note: "内容に納得できない" })}>拒否する（運営が対応）</button>
          </div>
        </div>
      )}

      {o.receiveCode && (
        <div className="card stack" style={{ textAlign: "center" }}>
          <strong>受け取りコード</strong>
          <QrImage text={`pashiri:${o.id}:${o.receiveCode}`} />
          <div className="big-code">{o.receiveCode}</div>
          <p className="muted small">パシリに QR を見せるか、コードを伝えてください。受け取ったら下のボタンでも完了できます。</p>
        </div>
      )}

      {o.status === "delivered" && (
        <div className="card stack">
          <button onClick={() => act("receive")}>受け取りました（支払いを確定）</button>
          <p className="muted small">{dt(o.autoCompleteAt)} までに操作がない場合は、自動で受け取り完了になります。</p>
        </div>
      )}

      <div className="card small">
        <h2>明細</h2>
        <table>
          <thead><tr><th>商品</th><th className="right">見積</th><th className="right">実際</th></tr></thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.id}>
                <td>{i.name} ×{i.qty}{i.outOfStock && <span className="badge bad">売り切れ</span>}{i.substitutionName && <div className="muted">→ 代わり：{i.substitutionName}</div>}</td>
                <td className="right">{yen(i.unitPriceJpy * i.qty)}</td>
                <td className="right">{i.actualUnitPriceJpy != null ? yen(i.actualUnitPriceJpy * (i.actualQty ?? 0)) : "—"}</td>
              </tr>
            ))}
            <tr><td>配達料</td><td className="right">{yen(o.estimatedDeliveryFeeJpy)}</td><td className="right">{yen(o.deliveryFeeJpy)}</td></tr>
            <tr><td>手数料</td><td className="right">{yen(o.estimatedPlatformFeeJpy)}</td><td className="right">{yen(o.platformFeeJpy)}</td></tr>
            <tr><th>合計</th><th className="right">{yen(o.estimatedTotalJpy)}</th><th className="right">{yen(o.finalTotalJpy)}</th></tr>
          </tbody>
        </table>
        <p className="muted">仮押さえ：{yen(o.holdAmountJpy)}（確定するのは実際の合計だけ）</p>
        {o.receiptUrl && <p><a href={o.receiptUrl} target="_blank" rel="noreferrer">レシート画像を見る</a></p>}
      </div>

      {o.canCancel && (
        <div className="card stack">
          {o.cancelDeadlineAt && <p className="muted small">{dt(o.cancelDeadlineAt)} までキャンセルできます</p>}
          <button className="secondary" onClick={() => confirm("キャンセルしますか？") && act("cancel")}>注文をキャンセル</button>
        </div>
      )}

      {o.status === "completed" && !o.rating && (
        <div className="card stack">
          <strong>パシリを評価して、ありがとうを伝える</strong>
          <select value={stars} onChange={(e) => setStars(Number(e.target.value))} aria-label="評価">
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}
          </select>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} aria-label="メッセージ" />
          <button onClick={() => act("rating", { stars, message })}>送る</button>
        </div>
      )}
      {o.rating && <div className="card small">あなたの評価：{"★".repeat(o.rating.stars)}「{o.rating.message}」</div>}

      {["purchased", "delivered"].includes(o.status) && (
        <div className="card stack">
          <strong>トラブルを運営に知らせる</strong>
          <textarea value={disputeText} onChange={(e) => setDisputeText(e.target.value)} placeholder="例：商品が違う、届かない" maxLength={500} aria-label="トラブルの内容" />
          <button className="danger" disabled={!disputeText} onClick={() => act("dispute", { reason: disputeText })}>知らせる</button>
        </div>
      )}

      <div className="card small">
        <h2>進行の記録</h2>
        {o.transitions.map((t, i) => <div key={i} className="muted">{dt(t.at)}　{STATUS_LABEL[t.from]} → {STATUS_LABEL[t.to]}</div>)}
      </div>
    </>
  );
}

function PaymentRetry({ orderId }: { orderId: string }) {
  const [msg, setMsg] = useState("");
  return (
    <div className="card stack">
      <p className="small">支払い画面を閉じてしまった場合、ここから確認できます。</p>
      <button className="secondary" onClick={async () => {
        try {
          const r = await api<{ status: string }>(`/api/customer/orders/${orderId}/confirm-payment`, { body: {} });
          setMsg(r.status === "placed" ? "仮押さえできました" : "まだ仮押さえが終わっていません");
          window.location.reload();
        } catch (e) {
          setMsg((e as Error).message);
        }
      }}>仮押さえの状態を確認する</button>
      {msg && <div className="msg info">{msg}</div>}
    </div>
  );
}
