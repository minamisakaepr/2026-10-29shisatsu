"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { QrScanner } from "@/components/Qr";
import { api, dt, REASON_LABEL, STATUS_LABEL, yen } from "@/lib/api";

interface Item { id: string; name: string; qty: number; unitPriceJpy: number; actualUnitPriceJpy: number | null; actualQty: number | null; outOfStock: boolean; substitutionName: string | null }
interface RunOrder {
  id: string; status: string; approvalStatus: string; approvalReasons: string[] | null; dropoffLabel: string; note: string;
  customer: { displayName: string; phone?: string | null; address?: string | null };
  items: Item[]; holdAmountJpy: number; estimatedItemsJpy: number; actualItemsJpy: number | null; deliveryFeeJpy: number | null; finalTotalJpy: number | null;
}
interface Run {
  id: string; status: string; shop: { name: string; address: string }; perks: { title: string; description: string }[];
  rewardJpy: number; receiptUrl: string | null; canWithdraw: boolean; withdrawDeadlineAt: string | null; orders: RunOrder[];
}
type Actual = { actualUnitPriceJpy: number; actualQty: number; outOfStock: boolean; substitutionName: string };

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState("");
  const [actual, setActual] = useState<Record<string, Actual>>({});
  const [file, setFile] = useState<File | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});

  const load = useCallback(() => api<Run>(`/api/runner/runs/${id}`).then((r) => {
    setRun(r);
    setActual((prev) => {
      const next = { ...prev };
      for (const o of r.orders) for (const i of o.items) next[i.id] ??= { actualUnitPriceJpy: i.unitPriceJpy, actualQty: i.qty, outOfStock: false, substitutionName: "" };
      return next;
    });
  }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function call(path: string, body: unknown = {}) {
    setErr("");
    try {
      await api(path, { body });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!run) return err ? <div className="msg error">{err}</div> : <p>読み込み中…</p>;
  const shopping = run.orders.filter((o) => o.status === "matched");

  return (
    <>
      <h1>{run.shop.name} へのおつかい</h1>
      <div className="card small">
        <div>{run.shop.address}</div>
        <div>報酬：<strong>{yen(run.rewardJpy)}</strong>（立替代金と一緒に、受け取り完了後に入金されます）</div>
        {run.perks.map((p) => <div key={p.title} className="badge ok">特典：{p.title}（{p.description}）</div>)}
      </div>
      {err && <div className="msg error">{err}</div>}

      {run.status === "shopping" && shopping.length > 0 && (
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!file) return setErr("レシートを撮影してください");
            const fd = new FormData();
            fd.append("receipt", file);
            fd.append("data", JSON.stringify({
              orders: shopping.map((o) => ({
                orderId: o.id,
                items: o.items.map((i) => ({ itemId: i.id, ...actual[i.id], substitutionName: actual[i.id].substitutionName || null })),
              })),
            }));
            setErr("");
            try {
              await api(`/api/runner/runs/${run.id}/receipt`, { form: fd });
              await load();
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
        >
          <h2>買い物リスト</h2>
          {shopping.map((o) => (
            <div key={o.id} className="card">
              <strong>{o.customer.displayName} さんの分</strong>
              {o.note && <div className="muted small">メモ：{o.note}</div>}
              {o.items.map((i) => {
                const a = actual[i.id];
                if (!a) return null;
                const set = (patch: Partial<Actual>) => setActual({ ...actual, [i.id]: { ...a, ...patch } });
                return (
                  <div key={i.id} className="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
                    <div>{i.name} ×{i.qty}（見積 {yen(i.unitPriceJpy)}/個）</div>
                    <div className="row">
                      <label className="row"><input type="checkbox" checked={a.outOfStock} onChange={(e) => set({ outOfStock: e.target.checked })} />売り切れ</label>
                      <span>単価</span><input className="qty" type="number" min={0} value={a.actualUnitPriceJpy} onChange={(e) => set({ actualUnitPriceJpy: Number(e.target.value) || 0 })} aria-label={`${i.name}の実際の単価`} />
                      <span>個数</span><input className="qty" type="number" min={0} value={a.actualQty} onChange={(e) => set({ actualQty: Number(e.target.value) || 0 })} aria-label={`${i.name}の実際の個数`} />
                    </div>
                    <input placeholder="代わりの商品（あれば）" value={a.substitutionName} onChange={(e) => set({ substitutionName: e.target.value })} maxLength={60} />
                  </div>
                );
              })}
            </div>
          ))}
          <label htmlFor="receipt">レシートの写真</label>
          <input id="receipt" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button>レシートを登録して配達へ</button>
          {run.canWithdraw && (
            <button type="button" className="secondary" onClick={() => confirm("引き受けを取り消しますか？") && call(`/api/runner/runs/${run.id}/withdraw`)}>
              引き受けを取り消す（{dt(run.withdrawDeadlineAt)} まで）
            </button>
          )}
        </form>
      )}

      {run.receiptUrl && <p className="small"><a href={run.receiptUrl} target="_blank" rel="noreferrer">登録したレシートを見る</a></p>}

      <h2>配達</h2>
      {run.orders.filter((o) => o.status !== "matched").map((o) => (
        <div key={o.id} className="card stack">
          <div className="between"><strong>{o.customer.displayName} さん</strong><span className="badge">{STATUS_LABEL[o.status]}</span></div>
          <div className="small">受け渡し場所：{o.dropoffLabel}</div>
          {o.customer.address && <div className="small">住所：{o.customer.address}</div>}
          {o.customer.phone && <div className="small">電話：<a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a></div>}
          {o.finalTotalJpy != null && <div className="small">お客さんの支払い {yen(o.finalTotalJpy)}（うち配達料 {yen(o.deliveryFeeJpy)}）</div>}
          {o.status === "purchased" && o.approvalStatus === "pending" && (
            <div className="msg info">お客さんの承認待ち：{(o.approvalReasons ?? []).map((r) => REASON_LABEL[r] ?? r).join("、")}</div>
          )}
          {o.status === "purchased" && o.approvalStatus !== "pending" && (
            <button onClick={() => call(`/api/runner/orders/${o.id}/deliver`)}>届けた</button>
          )}
          {o.status === "delivered" && (
            <div className="stack">
              <QrScanner onCode={(c) => setCodes((x) => ({ ...x, [o.id]: c }))} />
              <div className="row">
                <input inputMode="numeric" maxLength={6} placeholder="受け取りコード（6桁）" value={codes[o.id] ?? ""} onChange={(e) => setCodes({ ...codes, [o.id]: e.target.value })} aria-label="受け取りコード" style={{ flex: 1 }} />
                <button onClick={() => call(`/api/runner/orders/${o.id}/receive`, { code: codes[o.id] ?? "" })}>受け取り完了</button>
              </div>
            </div>
          )}
          {["purchased"].includes(o.status) && (
            <button className="secondary small" onClick={() => {
              const reason = prompt("トラブルの内容を入力してください");
              if (reason) call(`/api/runner/orders/${o.id}/dispute`, { reason });
            }}>トラブルを運営に知らせる</button>
          )}
        </div>
      ))}
    </>
  );
}
