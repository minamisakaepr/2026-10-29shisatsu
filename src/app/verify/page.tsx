"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function Verify() {
  const [state, setState] = useState<"busy" | "ok" | string>("busy");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    api("/api/auth/verify", { body: { token } })
      .then(() => setState("ok"))
      .catch((e) => setState((e as Error).message));
  }, []);
  return (
    <div className="card">
      <h1>メールアドレスの確認</h1>
      {state === "busy" && <p>確認しています…</p>}
      {state === "ok" && <p>確認できました。<Link href="/login">ログイン</Link>してください。</p>}
      {state !== "busy" && state !== "ok" && <div className="msg error">{state}</div>}
    </div>
  );
}
