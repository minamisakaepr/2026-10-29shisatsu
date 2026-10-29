"use client";
import { useCallback, useEffect, useState } from "react";
import { api, yen } from "@/lib/api";

interface Product { id: string; shopId: string; name: string; priceJpy: number; active: boolean; sortOrder: number }
interface Perk { id: string; shopId: string; title: string; description: string; active: boolean }
interface Stats { month: string; shops: { id: string; name: string; days: { date: string; orders: number; itemsJpy: number }[]; products: { name: string; qty: number }[] }[] }

export default function ShopPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [perks, setPerks] = useState<Perk[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState("");
  const [newP, setNewP] = useState({ shopId: "", name: "", priceJpy: 200 });
  const [newPerk, setNewPerk] = useState({ shopId: "", title: "", description: "" });

  const load = useCallback(async () => {
    try {
      const [p, k, s] = await Promise.all([api<Product[]>("/api/shop/products"), api<Perk[]>("/api/shop/perks"), api<Stats>("/api/shop/stats")]);
      setProducts(p); setPerks(k); setStats(s);
      const first = s.shops[0]?.id ?? "";
      setNewP((x) => ({ ...x, shopId: x.shopId || first }));
      setNewPerk((x) => ({ ...x, shopId: x.shopId || first }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(path: string, body: unknown, method = "PATCH") {
    setErr("");
    try {
      await api(path, { method, body });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const shopName = (id: string) => stats?.shops.find((s) => s.id === id)?.name ?? id;
  const shopSelect = (v: string, on: (v: string) => void) => (
    <select value={v} onChange={(e) => on(e.target.value)} aria-label="店">{stats?.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
  );

  return (
    <>
      <h1>お店の管理</h1>
      {err && <div className="msg error">{err}</div>}

      <h2>商品・価格</h2>
      <div className="card scroll-x">
        <table>
          <thead><tr><th>店</th><th>商品</th><th>価格</th><th>販売</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td className="small">{shopName(p.shopId)}</td>
                <td>{p.name}</td>
                <td>
                  <input className="qty" type="number" defaultValue={p.priceJpy} aria-label={`${p.name}の価格`}
                    onBlur={(e) => Number(e.target.value) !== p.priceJpy && save(`/api/shop/products/${p.id}`, { priceJpy: Number(e.target.value) })} />
                </td>
                <td><input type="checkbox" checked={p.active} onChange={(e) => save(`/api/shop/products/${p.id}`, { active: e.target.checked })} aria-label={`${p.name}を販売する`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">価格を変えても、すでに受けた注文は注文時の価格のままです。</p>
        <div className="row">
          {shopSelect(newP.shopId, (v) => setNewP({ ...newP, shopId: v }))}
          <input placeholder="商品名" value={newP.name} onChange={(e) => setNewP({ ...newP, name: e.target.value })} style={{ flex: 2 }} />
          <input className="qty" type="number" value={newP.priceJpy} onChange={(e) => setNewP({ ...newP, priceJpy: Number(e.target.value) })} aria-label="価格" />
          <button className="small" disabled={!newP.name} onClick={() => save("/api/shop/products", newP, "POST").then(() => setNewP({ ...newP, name: "" }))}>追加</button>
        </div>
      </div>

      <h2>パシリ特典</h2>
      <div className="card stack">
        {perks.map((k) => (
          <div key={k.id} className="between">
            <div><strong>{k.title}</strong><div className="muted small">{shopName(k.shopId)}・{k.description}</div></div>
            <label className="row small"><input type="checkbox" checked={k.active} onChange={(e) => save(`/api/shop/perks/${k.id}`, { active: e.target.checked })} />有効</label>
          </div>
        ))}
        <div className="row">
          {shopSelect(newPerk.shopId, (v) => setNewPerk({ ...newPerk, shopId: v }))}
          <input placeholder="特典（例：コーヒー1杯サービス）" value={newPerk.title} onChange={(e) => setNewPerk({ ...newPerk, title: e.target.value })} />
          <input placeholder="説明" value={newPerk.description} onChange={(e) => setNewPerk({ ...newPerk, description: e.target.value })} />
          <button className="small" disabled={!newPerk.title} onClick={() => save("/api/shop/perks", newPerk, "POST").then(() => setNewPerk({ ...newPerk, title: "", description: "" }))}>追加</button>
        </div>
      </div>

      <h2>注文集計（{stats?.month}）</h2>
      <p className="small"><a href={`/api/shop/stats.csv${stats ? `?month=${stats.month}` : ""}`}>CSV で書き出す</a>（個人情報は含みません）</p>
      {stats?.shops.map((s) => (
        <div key={s.id} className="card small">
          <strong>{s.name}</strong>
          {s.days.length === 0 ? <p className="muted">完了した注文はまだありません</p> : (
            <table>
              <thead><tr><th>日付</th><th>注文数</th><th>商品額</th></tr></thead>
              <tbody>{s.days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.orders}</td><td>{yen(d.itemsJpy)}</td></tr>)}</tbody>
            </table>
          )}
          {s.products.length > 0 && <p className="muted">よく出た商品：{s.products.slice(0, 5).map((p) => `${p.name}（${p.qty}）`).join("、")}</p>}
        </div>
      ))}
    </>
  );
}
