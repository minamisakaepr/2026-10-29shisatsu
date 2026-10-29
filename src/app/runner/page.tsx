"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, dt, yen } from "@/lib/api";

interface NearbyOrder { id: string; dropoffLabel: string; customerDisplayName: string; items: { name: string; qty: number }[]; estimatedItemsJpy: number; distanceKm: number; expiresAt: string }
interface Nearby {
  shops: { id: string; name: string; distanceKm: number; perks: { title: string }[]; orders: NearbyOrder[] }[];
  limits: { advanceLimitJpy: number; maxOrdersPerRun: number };
  payoutsEnabled: boolean;
}
interface Preview { rewardJpy: number; advanceJpy: number; isRain: boolean; isEarly: boolean; distanceKm: number }
interface Run { id: string; status: string; shopName: string; orderCount: number; rewardJpy: number; createdAt: string }

export default function RunnerHome() {
  const router = useRouter();
  const [data, setData] = useState<Nearby | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);

  const load = useCallback(() => {
    const q = pos ? `?lat=${pos.lat}&lng=${pos.lng}` : "";
    api<Nearby>(`/api/runner/orders/nearby${q}`).then(setData).catch((e) => setErr(e.message));
    api<Run[]>("/api/runner/runs").then(setRuns).catch(() => {});
  }, [pos]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setPreview(null);
    if (picked.length === 0) return;
    api<Preview>("/api/runner/runs/preview", { body: { orderIds: picked } }).then(setPreview).catch((e) => setErr(e.message));
  }, [picked]);

  const toggle = (shopId: string, orderId: string) => {
    setErr("");
    // まとめられるのは同じ店の注文だけ
    const sameShop = data?.shops.find((s) => s.id === shopId)?.orders.map((o) => o.id) ?? [];
    setPicked((p) => (p.includes(orderId) ? p.filter((x) => x !== orderId) : [...p.filter((x) => sameShop.includes(x)), orderId]));
  };

  const active = runs.filter((r) => r.status === "shopping" || r.status === "delivering");

  return (
    <>
      <h1>近くのおつかい</h1>
      {data && !data.payoutsEnabled && (
        <div className="msg error">引き受ける前に <Link href="/runner/onboarding">報酬の受け取り口座を登録</Link> してください。</div>
      )}
      {active.length > 0 && (
        <div className="card">
          <strong>進行中のおつかい</strong>
          {active.map((r) => <div key={r.id}><Link href={`/runner/runs/${r.id}`}>{r.shopName}（{r.orderCount}件・報酬 {yen(r.rewardJpy)}）</Link></div>)}
        </div>
      )}
      <div className="row small muted">
        <span>立替上限 {yen(data?.limits.advanceLimitJpy)}・まとめは最大 {data?.limits.maxOrdersPerRun}件</span>
        <button className="secondary small" onClick={() => navigator.geolocation?.getCurrentPosition((p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }))}>現在地で探す</button>
        <button className="secondary small" onClick={load}>更新</button>
      </div>
      {err && <div className="msg error">{err}</div>}
      {data?.shops.length === 0 && <p className="muted">いま近くに引き受け待ちの注文はありません。</p>}
      {data?.shops.map((s) => (
        <div key={s.id} className="card">
          <div className="between"><strong>{s.name}</strong><span className="muted small">{s.distanceKm}km</span></div>
          {s.perks.map((p) => <div key={p.title} className="badge ok">特典：{p.title}</div>)}
          {s.orders.map((o) => (
            <label key={o.id} className="card row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(s.id, o.id)} />
              <div style={{ flex: 1 }}>
                <div>{o.customerDisplayName} さん・{o.dropoffLabel}（店から {o.distanceKm}km）</div>
                <div className="muted small">{o.items.map((i) => `${i.name}×${i.qty}`).join("、")}</div>
                <div className="small">立替の目安 {yen(o.estimatedItemsJpy)}・期限 {dt(o.expiresAt)}</div>
              </div>
            </label>
          ))}
        </div>
      ))}
      {preview && (
        <div className="card stack" style={{ position: "sticky", bottom: 8 }}>
          <div>{picked.length}件をまとめて：報酬 <strong>{yen(preview.rewardJpy)}</strong>・立替 {yen(preview.advanceJpy)}</div>
          <div className="muted small">{preview.isRain && "雨の日割増あり・"}{preview.isEarly && "早朝割増あり・"}一番遠い受け渡しまで {preview.distanceKm}km</div>
          <button
            disabled={!data?.payoutsEnabled}
            onClick={async () => {
              try {
                const r = await api<{ id: string }>("/api/runner/runs", { body: { orderIds: picked } });
                router.push(`/runner/runs/${r.id}`);
              } catch (e) {
                setErr((e as Error).message);
                load();
              }
            }}
          >
            まとめて引き受ける
          </button>
        </div>
      )}
    </>
  );
}
