"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PaymentStep, type PaymentInfo } from "@/components/PaymentStep";
import { api, yen } from "@/lib/api";

interface Shop {
  id: string;
  name: string;
  address: string;
  products: { id: string; name: string; priceJpy: number }[];
  maxItemsPerOrder: number;
  estimate: { deliveryFeeJpy: number; platformFeeRate: number; holdBufferRate: number; distanceKm: number; inArea: boolean };
}

export default function ShopPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [shop, setShop] = useState<Shop | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [dropoffLabel, setDropoff] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [created, setCreated] = useState<{ id: string; holdAmountJpy: number; payment: PaymentInfo } | null>(null);

  useEffect(() => {
    api<Shop>(`/api/customer/shops/${id}`).then(setShop).catch((e) => setErr(e.message));
  }, [id]);

  if (!shop) return err ? <div className="msg error">{err}</div> : <p>読み込み中…</p>;

  const items = Object.entries(qty).filter(([, n]) => n > 0);
  const count = items.reduce((s, [, n]) => s + n, 0);
  const itemsJpy = items.reduce((s, [pid, n]) => s + (shop.products.find((p) => p.id === pid)?.priceJpy ?? 0) * n, 0);
  // 画面の表示は目安。正しい金額はサーバーが計算する
  const fee = Math.round(itemsJpy * shop.estimate.platformFeeRate);
  const total = itemsJpy + shop.estimate.deliveryFeeJpy + fee;

  if (created) {
    return (
      <>
        <h1>仮押さえ（与信）</h1>
        <PaymentStep orderId={created.id} payment={created.payment} amountLabel={yen(created.holdAmountJpy)} onDone={() => router.push(`/customer/orders/${created.id}`)} />
      </>
    );
  }

  return (
    <>
      <h1>{shop.name}</h1>
      <p className="muted small">{shop.address}・あなたの場所から {shop.estimate.distanceKm}km</p>
      {!shop.estimate.inArea && <div className="msg error">対応エリアの外のため注文できません</div>}
      <div className="card">
        {shop.products.map((p) => (
          <div key={p.id} className="between" style={{ padding: "6px 0" }}>
            <div>{p.name}<div className="muted small">{yen(p.priceJpy)}</div></div>
            <input
              className="qty" type="number" min={0} max={shop.maxItemsPerOrder} aria-label={`${p.name}の個数`}
              value={qty[p.id] ?? 0} onChange={(e) => setQty({ ...qty, [p.id]: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
        ))}
      </div>
      <div className="card">
        <label htmlFor="drop">受け渡し場所（パシリに見えます。例：〇〇公園の入口）</label>
        <input id="drop" value={dropoffLabel} onChange={(e) => setDropoff(e.target.value)} maxLength={60} />
        <label htmlFor="note">メモ（任意）</label>
        <input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </div>
      <div className="card small">
        <div className="between"><span>商品（見積）</span><span>{yen(itemsJpy)}</span></div>
        <div className="between"><span>配達料（1人で頼んだ場合。まとめられると安くなります）</span><span>{yen(shop.estimate.deliveryFeeJpy)}</span></div>
        <div className="between"><span>手数料（目安）</span><span>{yen(fee)}</span></div>
        <div className="between"><strong>合計（目安）</strong><strong>{yen(total)}</strong></div>
        <p className="muted">売り切れ・価格の違いに備えて、合計の {Math.round(shop.estimate.holdBufferRate * 100)}% 増しで仮押さえします。受け取り時に実際の金額だけが確定します。</p>
      </div>
      {err && <div className="msg error">{err}</div>}
      <button
        disabled={count === 0 || count > shop.maxItemsPerOrder || !dropoffLabel || !shop.estimate.inArea}
        onClick={async () => {
          setErr("");
          try {
            const r = await api<{ id: string; holdAmountJpy: number; payment: PaymentInfo }>("/api/customer/orders", {
              body: { shopId: shop.id, items: items.map(([productId, n]) => ({ productId, qty: n })), dropoffLabel, note },
            });
            setCreated(r);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      >
        注文して仮押さえへ進む
      </button>
      {count > shop.maxItemsPerOrder && <p className="msg error">1回の注文は {shop.maxItemsPerOrder} 点までです</p>}
    </>
  );
}
