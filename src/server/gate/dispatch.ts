// 門番（API 用）。/api/ へのリクエストはすべてここを通る。
//  1. 台帳で出入り口を探す（なければ拒否）
//  2. ログイン状態を確かめ、ロールに合う許可行を探す（なければ拒否）
//  3. CSRF / Webhook 署名 / 理由の入力 / 入力値をチェック
//  4. データ範囲（scope）を確かめる
//  5. 処理を呼び、見せてよい項目だけに絞って返す
//  6. 許可・拒否・エラーをすべて通行記録に残す
import { ZodError } from "zod";
import { loadEnv } from "../env";
import { AppError } from "../lib/errors";
import { resolveSettings } from "../settings/service";
import { appendAudit, type AuditResult } from "./audit";
import { findGrant, getLedger, matchEntrance, METHOD_OPS, type Entrance, type Grant } from "./ledger";
import { project } from "./projection";
import { assertInScope, scopeWhere } from "./scopes";
import { checkCsrf, clientIp, principalFromToken, readCookie, SESSION_COOKIE, type Principal } from "./session";
import { RawResponse, WithHeaders, type Ctx, type EndpointDef } from "./types";

let registry: Map<string, EndpointDef> | null = null;

export function setRegistry(defs: EndpointDef[]) {
  registry = new Map(defs.map((d) => [d.id, d]));
}

function json(status: number, body: unknown, headers?: Record<string, string | string[]>) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  for (const [k, v] of Object.entries(headers ?? {})) {
    for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
  }
  return new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: h });
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

export async function dispatch(req: Request): Promise<Response> {
  if (!registry) throw new Error("API の登録がされていません");
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const ip = clientIp(req);
  const ledger = getLedger();

  let principal: Principal = await principalFromToken(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  let entrance: Entrance | null = null;
  let grant: Grant | null = null;
  let target: string = url.pathname;

  const audit = (result: AuditResult, status: number, why?: string, extra?: Record<string, unknown>) =>
    appendAudit({
      userId: principal.userId,
      role: grant?.role ?? principal.roles.join(","),
      entrance: entrance?.id ?? "unknown",
      operation: grant ? (grant.ops.find((o) => METHOD_OPS[method]?.includes(o)) ?? method) : method,
      target,
      result,
      ip,
      detail: { method, path: url.pathname, status, ...(why ? { why } : {}), ...extra },
    });

  const deny = async (status: number, code: string, message: string, why: string) => {
    await audit("deny", status, why);
    return json(status, errorBody(code, message));
  };

  // 1. 台帳にない出入り口は拒否（デフォルト拒否）
  const match = matchEntrance(ledger, ["api", "webhook", "file", "export"], method, url.pathname);
  if (!match) return deny(404, "not_found", "見つかりません", "台帳にない出入り口");
  entrance = match.entrance;
  const def = registry.get(entrance.id);
  if (!def) return deny(404, "not_found", "見つかりません", "処理が登録されていない出入り口");

  // 2. ロールに合う許可行を探す
  grant = findGrant(entrance, principal.roles, method);
  if (!grant) {
    const loggedIn = principal.userId !== null;
    // ログイン済みでも、anonymous にだけ許可された出入り口（新規登録など）は使えない
    return deny(loggedIn ? 403 : 401, loggedIn ? "forbidden" : "login_required",
      loggedIn ? "この操作は許可されていません" : "ログインしてください", "台帳に許可行がない");
  }
  if (grant.role === "anonymous" && principal.userId !== null && entrance.grants.every((g) => g.role === "anonymous")) {
    return deny(403, "forbidden", "ログイン中は使えません", "未ログイン専用");
  }

  const env = loadEnv();
  try {
    // 3. CSRF / 署名
    let rawBody: string | null = null;
    if (entrance.signature === "stripe") {
      rawBody = await req.text();
    } else if (method !== "GET") {
      const csrfErr = checkCsrf(req, env.appUrl);
      if (csrfErr) return deny(403, "csrf", "画面を読み込み直してから、もう一度お試しください", csrfErr);
    }

    // 入力値
    let body: Record<string, unknown> = {};
    let form: FormData | null = null;
    const kind = def.body ?? (method === "GET" ? "none" : "json");
    if (kind === "json") {
      const text = await req.text();
      if (text.length > 100_000) return deny(413, "too_large", "送信データが大きすぎます", "本文が大きすぎる");
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return deny(400, "bad_json", "送信データの形式が正しくありません", "JSON が読めない");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return deny(400, "bad_json", "送信データの形式が正しくありません", "JSON がオブジェクトでない");
      }
    } else if (kind === "multipart") {
      form = await req.formData();
      const data = form.get("data");
      body = typeof data === "string" && data ? JSON.parse(data) : {};
    }
    const raw = method === "GET" || kind === "none" ? Object.fromEntries(url.searchParams) : body;

    // 理由の入力（require_reason）
    let reason: string | null = null;
    if (entrance.require_reason) {
      const r = (raw as Record<string, unknown>).reason ?? url.searchParams.get("reason");
      const min = (await resolveSettings()).reason_min_length;
      if (typeof r !== "string" || r.trim().length < min) {
        return deny(400, "reason_required", `理由を${min}文字以上で入力してください`, "理由の入力がない");
      }
      reason = r.trim().slice(0, 500);
    }

    let input: unknown = raw;
    if (def.input) {
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "入力"}: ${i.message}`).join(" / ");
        return deny(400, "invalid_input", `入力が正しくありません（${msg}）`, "入力値の検証に失敗");
      }
      input = parsed.data;
    }

    // 4. データ範囲
    let where: Record<string, unknown> = {};
    if (entrance.resource && grant.scope !== "public") {
      where = await scopeWhere(entrance.resource, grant.scope, principal);
      const id = match.params.id;
      if (id) {
        target = `${entrance.resource}:${id}`;
        await assertInScope(entrance.resource, id, where);
      }
    }

    const ctx: Ctx = {
      req, principal, userId: principal.userId ?? "", role: grant.role, entrance, grant,
      params: match.params, query: url.searchParams, input, where, form, rawBody, ip, reason,
    };

    // 5. 処理を呼ぶ
    const result = await def.handler(ctx);

    // ログイン・ログアウトで principal が変わった場合、記録には新しい方を使う
    if (result instanceof WithHeaders && result.principal) principal = result.principal;

    if (result instanceof RawResponse) {
      await audit("allow", result.response.status, undefined, reason ? { reason } : undefined);
      return result.response;
    }
    const data = result instanceof WithHeaders ? result.data : result;
    const status = result instanceof WithHeaders ? result.status : 200;
    const visible = project(data, grant.fields);
    await audit("allow", status, undefined, reason ? { reason } : undefined);
    return json(status, { data: visible }, result instanceof WithHeaders ? result.headers : undefined);
  } catch (err) {
    if (err instanceof AppError) {
      await audit(err.status >= 500 ? "error" : "deny", err.status, err.message);
      return json(err.status, errorBody(err.code, err.message));
    }
    if (err instanceof ZodError) {
      await audit("deny", 400, "入力値の検証に失敗");
      return json(400, errorBody("invalid_input", "入力が正しくありません"));
    }
    console.error(`[${entrance?.id}]`, err);
    await audit("error", 500, err instanceof Error ? err.message : String(err)).catch(() => {});
    return json(500, errorBody("server_error", "サーバーでエラーが起きました。時間をおいてお試しください"));
  }
}
