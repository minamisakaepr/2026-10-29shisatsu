"use client";
import { useState } from "react";
import { api } from "@/lib/api";

export default function Signup() {
  const [form, setForm] = useState({ email: "", password: "", displayName: "", asRunner: false });
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  if (done) {
    return (
      <div className="card">
        <h1>確認メールを送りました</h1>
        <p>メールに書かれたリンクを開くと、登録が完了します。</p>
        <p className="muted small">（開発中は、メールの代わりにサーバーのログに確認リンクが表示されます）</p>
      </div>
    );
  }
  return (
    <>
      <h1>新規登録</h1>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          try {
            await api("/api/auth/signup", { body: form });
            setDone(true);
          } catch (e2) {
            setErr((e2 as Error).message);
          }
        }}
      >
        <label htmlFor="name">表示名（パシリ・お客さんに見える名前）</label>
        <input id="name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required maxLength={30} />
        <label htmlFor="email">メールアドレス</label>
        <input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <label htmlFor="pw">パスワード</label>
        <input id="pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <label className="row">
          <input type="checkbox" checked={form.asRunner} onChange={(e) => setForm({ ...form, asRunner: e.target.checked })} />
          パシリ（おつかいをする人）としても登録する
        </label>
        {err && <div className="msg error">{err}</div>}
        <p><button>登録する</button></p>
      </form>
    </>
  );
}
