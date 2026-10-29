"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function Onboarding() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<{ payoutsEnabled: boolean }>("/api/runner/onboarding/sync", { body: {} }).then((r) => setEnabled(r.payoutsEnabled)).catch((e) => setErr(e.message));
  }, []);
  return (
    <>
      <h1>報酬の受け取り口座</h1>
      <div className="card stack">
        <p>立て替えた代金と報酬は、Stripe を通してあなたの銀行口座に入金されます。運営があなたのお金を預かることはありません。</p>
        {enabled === true && <div className="msg info">登録済みです。<Link href="/runner">おつかいを探す</Link></div>}
        {enabled === false && (
          <button onClick={async () => {
            setErr("");
            try {
              const r = await api<{ url: string | null; payoutsEnabled: boolean }>("/api/runner/onboarding", { body: {} });
              if (r.url) window.location.href = r.url; // Stripe の登録画面へ
              else setEnabled(r.payoutsEnabled);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}>Stripe で口座を登録する</button>
        )}
        {err && <div className="msg error">{err}</div>}
      </div>
    </>
  );
}
