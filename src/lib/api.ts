"use client";
// 画面から API を呼ぶための小さな関数。CSRF トークン（クッキー）をヘッダーに付けて送る。

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)pashiri_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-csrf-token"] = csrfToken();
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method, headers, body, credentials: "same-origin" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? "エラーが起きました");
  }
  return json.data as T;
}

export const yen = (n: number | null | undefined) => (n == null ? "—" : `${n.toLocaleString("ja-JP")}円`);
export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

export const STATUS_LABEL: Record<string, string> = {
  draft: "支払い待ち",
  placed: "パシリを探しています",
  matched: "パシリが決まりました",
  purchased: "買い物が終わり、配達中",
  delivered: "届きました（受け取り確認待ち）",
  completed: "完了",
  cancelled: "キャンセル",
  disputed: "運営が対応中",
  expired: "期限切れ（引き受け手なし）",
};

export const REASON_LABEL: Record<string, string> = {
  over_hold: "金額が仮押さえ額を超えました",
  price_diff: "見積と実額の差が大きいです",
  substitution: "代わりの商品があります",
  out_of_stock: "売り切れの商品があります",
};
