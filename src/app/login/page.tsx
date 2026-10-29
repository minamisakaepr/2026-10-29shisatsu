"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";

const HOME: Record<string, string> = { admin: "/admin", shop: "/shop", runner: "/runner", customer: "/customer" };

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <h1>ログイン</h1>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          try {
            const r = await api<{ roles: string[] }>("/api/auth/login", { body: { email, password } });
            const next = new URLSearchParams(window.location.search).get("next");
            // 戻り先は自分のサイトの中だけ（外部サイトへの転送に使われないように）
            const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
            const role = ["customer", "runner", "shop", "admin"].find((r2) => r.roles.includes(r2));
            window.location.href = safeNext ?? (role ? HOME[role] : "/");
          } catch (e2) {
            setErr((e2 as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="email">メールアドレス</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="password">パスワード</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {err && <div className="msg error">{err}</div>}
        <p><button disabled={busy}>ログイン</button></p>
        <p className="small muted">はじめての方は <Link href="/signup">新規登録</Link></p>
      </form>
    </>
  );
}
