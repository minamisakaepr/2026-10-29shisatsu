// アクセス台帳（security/access_ledger.yaml）の読み込みと照合。
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const ROLES = ["anonymous", "customer", "runner", "shop", "admin", "system"] as const;
export const OPS = ["read", "create", "update", "delete"] as const;
export const SCOPES = ["public", "self", "own", "assigned", "shop", "nearby", "catalog", "all"] as const;
export const KINDS = ["api", "page", "webhook", "job", "file", "export"] as const;
export const RESOURCES = ["order", "run", "shop", "product", "perk", "receipt", "user", "setting", "dispute"] as const;

export type LedgerRole = (typeof ROLES)[number];
export type Op = (typeof OPS)[number];
export type Scope = (typeof SCOPES)[number];
export type Kind = (typeof KINDS)[number];
export type Resource = (typeof RESOURCES)[number];

const fieldSchema = z.union([
  z.string().min(1),
  z.object({ path: z.string().min(1), when: z.object({ status: z.array(z.string()).min(1) }) }).strict(),
]);

const grantSchema = z
  .object({
    role: z.enum(ROLES),
    ops: z.array(z.enum(OPS)).min(1),
    scope: z.enum(SCOPES),
    fields: z.array(fieldSchema).optional(),
    reason: z.string().min(2),
  })
  .strict();

const entranceSchema = z
  .object({
    id: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
    kind: z.enum(KINDS),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    path: z.string().startsWith("/").optional(),
    resource: z.enum(RESOURCES).optional(),
    require_reason: z.boolean().optional(),
    signature: z.literal("stripe").optional(),
    grants: z.array(grantSchema).min(1),
  })
  .strict();

const ledgerSchema = z.object({ version: z.literal(1), entrances: z.array(entranceSchema) }).strict();

export type Field = z.infer<typeof fieldSchema>;
export type Grant = z.infer<typeof grantSchema>;
export type Entrance = z.infer<typeof entranceSchema> & { pattern?: RegExp; paramNames?: string[] };
export interface Ledger {
  entrances: Entrance[];
  byId: Map<string, Entrance>;
}

// どの操作が、どの HTTP メソッドで行われるか
export const METHOD_OPS: Record<string, Op[]> = {
  GET: ["read"],
  POST: ["create", "update", "read"],
  PUT: ["update"],
  PATCH: ["update"],
  DELETE: ["delete"],
};

// リソースごとに使ってよいデータ範囲（ここにない組み合わせは台帳の読み込み時にエラー）
export const SUPPORTED_SCOPES: Record<Resource, Scope[]> = {
  order: ["own", "assigned", "shop", "nearby", "all"],
  run: ["assigned", "all"],
  shop: ["catalog", "shop", "all"],
  product: ["shop", "catalog", "all"],
  perk: ["shop", "catalog", "all"],
  receipt: ["own", "assigned", "all"],
  user: ["self", "all"],
  setting: ["all"],
  dispute: ["all"],
};

const NO_WILDCARD: Resource[] = ["order", "run", "user"];

function compilePath(p: string) {
  const paramNames: string[] = [];
  const re = p
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${re}$`), paramNames };
}

/** 台帳の中身の整合性チェック。問題の一覧を返す（空なら OK） */
export function lintLedger(entrances: Entrance[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const e of entrances) {
    if (ids.has(e.id)) problems.push(`${e.id}: id が重複しています`);
    ids.add(e.id);
    if (e.kind === "job") {
      if (e.path || e.method) problems.push(`${e.id}: 定期処理に path / method は書けません`);
      if (e.grants.some((g) => g.role !== "system")) problems.push(`${e.id}: 定期処理は system ロールだけに許可できます`);
    } else {
      if (!e.path) problems.push(`${e.id}: path がありません`);
      if (e.kind !== "page" && !e.method) problems.push(`${e.id}: method がありません`);
      if (e.kind === "page" && e.method) problems.push(`${e.id}: 画面に method は書けません`);
      const route = `${e.method ?? "PAGE"} ${e.path}`;
      if (routes.has(route)) problems.push(`${e.id}: ${route} が重複しています`);
      routes.add(route);
      if (e.grants.some((g) => g.role === "system")) problems.push(`${e.id}: system ロールは定期処理にしか許可できません`);
    }
    if (e.kind === "webhook" && e.signature !== "stripe") problems.push(`${e.id}: Webhook には署名検証（signature）が必須です`);
    if (e.kind !== "webhook" && e.signature) problems.push(`${e.id}: signature は Webhook 専用です`);
    if (e.path?.startsWith("/api/") && e.kind === "page") problems.push(`${e.id}: /api/ は画面にできません`);
    if (e.kind !== "page" && e.kind !== "job" && !e.path?.startsWith("/api/")) problems.push(`${e.id}: API は /api/ で始めてください`);
    const roles = new Set<string>();
    for (const g of e.grants) {
      if (roles.has(g.role)) problems.push(`${e.id}: ロール ${g.role} が重複しています`);
      roles.add(g.role);
      if (g.scope === "all" && !["admin", "system"].includes(g.role)) problems.push(`${e.id}: scope=all は admin / system だけです`);
      if (g.scope === "public" && e.resource && !["user"].includes(e.resource)) problems.push(`${e.id}: リソース付きの出入り口に scope=public は使えません`);
      if (g.role === "anonymous" && g.scope !== "public") problems.push(`${e.id}: 未ログイン（anonymous）は scope=public だけです`);
      if (e.resource && g.scope !== "public" && !SUPPORTED_SCOPES[e.resource].includes(g.scope)) {
        problems.push(`${e.id}: ${e.resource} に scope=${g.scope} は使えません`);
      }
      if (e.method && !g.ops.some((op) => METHOD_OPS[e.method!].includes(op))) {
        problems.push(`${e.id}: ${e.method} に合う操作が ops にありません`);
      }
      const needsFields = ["api", "webhook", "export"].includes(e.kind);
      if (needsFields && !g.fields?.length) problems.push(`${e.id}: ${g.role} に fields（見せてよい項目）がありません`);
      if (!needsFields && g.fields) problems.push(`${e.id}: ${e.kind} に fields は書けません`);
      const wild = g.fields?.some((f) => f === "*");
      if (wild && e.resource && NO_WILDCARD.includes(e.resource)) problems.push(`${e.id}: ${e.resource} に fields "*" は使えません`);
    }
  }
  return problems;
}

export function parseLedger(text: string): Ledger {
  const parsed = ledgerSchema.parse(YAML.parse(text));
  const entrances: Entrance[] = parsed.entrances.map((e) => (e.path ? { ...e, ...compilePath(e.path) } : { ...e }));
  const problems = lintLedger(entrances);
  if (problems.length) throw new Error(`アクセス台帳に問題があります:\n- ${problems.join("\n- ")}`);
  return { entrances, byId: new Map(entrances.map((e) => [e.id, e])) };
}

let cached: Ledger | null = null;
export const LEDGER_FILE = () => path.join(process.cwd(), "security", "access_ledger.yaml");

export function getLedger(): Ledger {
  if (!cached) cached = parseLedger(readFileSync(LEDGER_FILE(), "utf8"));
  return cached;
}

export interface Match {
  entrance: Entrance;
  params: Record<string, string>;
}

/** パスとメソッドから出入り口を探す。見つからなければ null（＝拒否） */
export function matchEntrance(ledger: Ledger, kinds: Kind[], method: string | null, pathname: string): Match | null {
  const p = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  for (const e of ledger.entrances) {
    if (!kinds.includes(e.kind) || !e.pattern) continue;
    if (method && e.method !== method) continue;
    const m = e.pattern.exec(p);
    if (!m) continue;
    const params: Record<string, string> = {};
    e.paramNames!.forEach((n, i) => {
      params[n] = decodeURIComponent(m[i + 1]);
    });
    return { entrance: e, params };
  }
  return null;
}

/** ユーザーのロールに合う許可行を探す。見つからなければ null（＝拒否） */
export function findGrant(e: Entrance, roles: LedgerRole[], method?: string | null): Grant | null {
  const ops = method ? METHOD_OPS[method] : null;
  for (const g of e.grants) {
    if (!roles.includes(g.role)) continue;
    if (ops && !g.ops.some((op) => ops.includes(op))) continue;
    return g;
  }
  return null;
}
