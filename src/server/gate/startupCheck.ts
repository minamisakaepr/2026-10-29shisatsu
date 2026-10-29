// 起動時チェック：コード上の出入り口と台帳を突き合わせる。1つでもずれていたら起動しない。
//  ・登録された API 処理が台帳にない           → 失敗（台帳に書かれていない出入り口を作らせない）
//  ・台帳の API / Webhook / ファイル / 書き出しに処理がない → 失敗
//  ・画面（page.tsx）が台帳にない / 台帳の画面にファイルがない → 失敗
//  ・定期処理が台帳にない / 台帳の定期処理に処理がない → 失敗
//  ・src/app/api の下に、共通の入口以外の route.ts がある → 失敗（門番を通らない抜け道になるため）
//  ・設定キーが YAML とコードでずれている → 失敗
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { KNOWN_KEYS, loadDefaultDefs } from "../settings/definitions";
import { getLedger } from "./ledger";
import type { EndpointDef } from "./types";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** src/app の page.tsx から、画面のパス（/customer/orders/:id など）を作る */
export function pageRoutes(appDir: string): string[] {
  return walk(appDir)
    .filter((f) => /[\\/]page\.tsx$/.test(f))
    .map((f) => {
      const rel = path.relative(appDir, path.dirname(f)).split(path.sep).filter(Boolean);
      const segs = rel
        .filter((s) => !(s.startsWith("(") && s.endsWith(")"))) // (グループ) は URL に出ない
        .map((s) => (s.startsWith("[") ? `:${s.replace(/^\[+\.{0,3}|\]+$/g, "")}` : s));
      return `/${segs.join("/")}`;
    });
}

export function apiRouteFiles(appDir: string): string[] {
  const apiDir = path.join(appDir, "api");
  return walk(apiDir)
    .filter((f) => /[\\/]route\.(ts|tsx|js)$/.test(f))
    .map((f) => path.relative(appDir, f).split(path.sep).join("/"));
}

export function checkStartup(opts: { endpoints: EndpointDef[]; jobIds: string[]; appDir?: string }): string[] {
  const problems: string[] = [];
  const ledger = getLedger();
  const appDir = opts.appDir ?? path.join(process.cwd(), "src", "app");

  const httpKinds = ["api", "webhook", "file", "export"];
  const codeIds = new Set(opts.endpoints.map((e) => e.id));
  if (codeIds.size !== opts.endpoints.length) problems.push("同じ id の API 処理が2つ登録されています");
  for (const id of codeIds) {
    const e = ledger.byId.get(id);
    if (!e) problems.push(`API 処理 ${id} が台帳にありません`);
    else if (!httpKinds.includes(e.kind)) problems.push(`API 処理 ${id} は台帳では ${e.kind} です`);
  }
  for (const e of ledger.entrances.filter((x) => httpKinds.includes(x.kind))) {
    if (!codeIds.has(e.id)) problems.push(`台帳の ${e.id} に処理がありません`);
  }

  const pages = new Set(pageRoutes(appDir));
  const ledgerPages = new Set(ledger.entrances.filter((e) => e.kind === "page").map((e) => e.path!));
  for (const p of pages) if (!ledgerPages.has(p)) problems.push(`画面 ${p} が台帳にありません`);
  for (const p of ledgerPages) if (!pages.has(p)) problems.push(`台帳の画面 ${p} のファイルがありません`);

  const ledgerJobs = new Set(ledger.entrances.filter((e) => e.kind === "job").map((e) => e.id));
  for (const j of opts.jobIds) if (!ledgerJobs.has(j)) problems.push(`定期処理 ${j} が台帳にありません`);
  for (const j of ledgerJobs) if (!opts.jobIds.includes(j)) problems.push(`台帳の定期処理 ${j} に処理がありません`);

  for (const f of apiRouteFiles(appDir)) {
    if (f !== "api/[...path]/route.ts") problems.push(`${f} は門番を通らない API です。src/server/endpoints に登録してください`);
  }

  const defs = loadDefaultDefs();
  for (const k of KNOWN_KEYS) if (!defs.has(k)) problems.push(`設定キー ${k} が settings.default.yaml にありません`);
  for (const k of defs.keys()) if (!(KNOWN_KEYS as string[]).includes(k)) problems.push(`settings.default.yaml の ${k} をコードが知りません（definitions.ts に追加）`);

  return problems;
}
