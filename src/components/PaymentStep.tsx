"use client";
// 仮押さえ（与信）の支払い画面。カード番号は Stripe の画面（Payment Element）が直接受け取り、
// このアプリのサーバーには一切届かない。モックのときは「テストカードで支払う」ボタンだけ出す。
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";

export interface PaymentInfo {
  mode: "mock" | "stripe";
  clientSecret: string;
  publishableKey: string | null;
}

const stripeCache = new Map<string, Promise<Stripe | null>>();

export function PaymentStep({ orderId, payment, amountLabel, onDone }: { orderId: string; payment: PaymentInfo; amountLabel: string; onDone: () => void }) {
  if (payment.mode === "mock") return <MockPay orderId={orderId} amountLabel={amountLabel} onDone={onDone} />;
  const key = payment.publishableKey!;
  if (!stripeCache.has(key)) stripeCache.set(key, loadStripe(key));
  return (
    <Elements stripe={stripeCache.get(key)!} options={{ clientSecret: payment.clientSecret, locale: "ja" }}>
      <StripePay orderId={orderId} amountLabel={amountLabel} onDone={onDone} />
    </Elements>
  );
}

function MockPay({ orderId, amountLabel, onDone }: { orderId: string; amountLabel: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="card stack">
      <div className="msg info">いまは<strong>モック決済</strong>（偽物の Stripe）で動いています。本物のカードは使いません。</div>
      <div>仮押さえする金額：<strong>{amountLabel}</strong></div>
      {err && <div className="msg error">{err}</div>}
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await api(`/api/customer/orders/${orderId}/confirm-payment`, { body: {} });
            onDone();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        テストカードで支払う（仮押さえ）
      </button>
    </div>
  );
}

function StripePay({ orderId, amountLabel, onDone }: { orderId: string; amountLabel: string; onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const note = useMemo(() => "テストモードです。カード番号 4242 4242 4242 4242、有効期限は未来の日付、CVC は任意の3桁で試せます。", []);
  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!stripe || !elements) return;
        setBusy(true);
        setErr("");
        const r = await stripe.confirmPayment({ elements, redirect: "if_required" });
        if (r.error) {
          setErr(r.error.message ?? "支払いに失敗しました");
          setBusy(false);
          return;
        }
        try {
          await api(`/api/customer/orders/${orderId}/confirm-payment`, { body: {} });
          onDone();
        } catch (e2) {
          setErr((e2 as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="msg info">{note}</div>
      <div>仮押さえする金額：<strong>{amountLabel}</strong>（受け取り時に実額だけ確定し、残りは解放されます）</div>
      <PaymentElement />
      {err && <div className="msg error">{err}</div>}
      <button disabled={busy || !stripe}>仮押さえする</button>
    </form>
  );
}
