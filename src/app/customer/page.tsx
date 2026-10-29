"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Shop { id: string; name: string; address: string; areaName: string; distanceKm: number | null; inArea: boolean }

export default function CustomerHome() {
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Shop[]>("/api/customer/shops").then(setShops).catch((e) => setErr(e.message));
  }, []);
  return (
    <>
      <h1>お店を選ぶ</h1>
      {err && <div className="msg error">{err}</div>}
      {shops?.length === 0 && <p className="muted">注文できるお店はまだありません。</p>}
      {shops?.map((s) => (
        <div key={s.id} className="card between">
          <div>
            <strong>{s.name}</strong>
            <div className="muted small">{s.areaName}・{s.distanceKm != null ? `${s.distanceKm}km` : "距離不明"}</div>
          </div>
          {s.inArea ? <Link className="btn" href={`/customer/shops/${s.id}`}>選ぶ</Link> : <span className="badge">対応エリア外</span>}
        </div>
      ))}
    </>
  );
}
