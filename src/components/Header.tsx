"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Me {
  loggedIn: boolean;
  displayName?: string;
  roles?: string[];
}

export function Header() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => setMe({ loggedIn: false }));
  }, []);
  const has = (r: string) => me?.roles?.includes(r);
  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    window.location.href = "/login";
  }
  return (
    <header className="top">
      <Link href="/" className="brand">🥐 パシリ</Link>
      <nav>
        {has("customer") && <Link href="/customer">注文する</Link>}
        {has("customer") && <Link href="/customer/orders">注文履歴</Link>}
        {has("runner") && <Link href="/runner">おつかいを探す</Link>}
        {has("runner") && <Link href="/runner/earnings">報酬</Link>}
        {has("shop") && <Link href="/shop">お店の管理</Link>}
        {has("admin") && <Link href="/admin">運営</Link>}
      </nav>
      <span className="spacer" />
      {me?.loggedIn ? (
        <span className="row small">
          <span className="muted">{me.displayName}</span>
          <button className="secondary small" onClick={logout}>ログアウト</button>
        </span>
      ) : (
        <Link href="/login" className="small">ログイン</Link>
      )}
    </header>
  );
}
