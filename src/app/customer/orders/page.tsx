"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, dt, STATUS_LABEL, yen } from "@/lib/api";

interface Row { id: string; status: string; shopName: string; itemCount: number; estimatedTotalJpy: number; finalTotalJpy: number | null; approvalStatus: string; createdAt: string }

export default function Orders() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Row[]>("/api/customer/orders").then(setRows).catch((e) => setErr(e.message));
  }, []);
  return (
    <>
      <h1>注文履歴</h1>
      {err && <div className="msg error">{err}</div>}
      {rows?.length === 0 && <p className="muted">まだ注文はありません。</p>}
      {rows?.map((o) => (
        <Link key={o.id} href={`/customer/orders/${o.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="card between">
            <div>
              <strong>{o.shopName}</strong>（{o.itemCount}点）
              <div className="muted small">{dt(o.createdAt)}</div>
            </div>
            <div className="right">
              <span className={`badge ${o.status === "completed" ? "ok" : ""}`}>{STATUS_LABEL[o.status]}</span>
              {o.approvalStatus === "pending" && <div className="badge bad">承認してください</div>}
              <div className="small">{yen(o.finalTotalJpy ?? o.estimatedTotalJpy)}</div>
            </div>
          </div>
        </Link>
      ))}
    </>
  );
}
