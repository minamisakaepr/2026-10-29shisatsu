// 設定値の定義（型・範囲）と入力チェック。DB を使わない純粋な部分。
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type SettingType = "int" | "decimal" | "bool" | "string" | "enum" | "timerange" | "json";

export interface SettingDef {
  key: string;
  value: unknown;
  type: SettingType;
  unit: string;
  description: string;
  min?: number;
  max?: number;
  options?: string[];
  pattern?: string;
}

export interface TitleRule {
  monthly_runs?: number;
  total_runs?: number;
  min_avg_rating?: number;
}

/** コードが使う設定キーの一覧と型。YAML とずれていると起動時チェックで止まる */
export interface Settings {
  hold_buffer_rate: number;
  price_diff_tolerance_rate: number;
  runner_advance_limit_jpy: number;
  max_orders_per_run: number;
  reward_base_jpy: number;
  reward_per_order_jpy: number;
  surcharge_rain_jpy: number;
  surcharge_early_jpy: number;
  early_hours: string;
  surcharge_per_km_jpy: number;
  platform_fee_rate: number;
  auto_complete_minutes: number;
  payout_timing: "same_day" | "next_day" | "weekly";
  payout_hour: string;
  cancel_deadline_minutes: number;
  order_expire_minutes: number;
  service_radius_km: number;
  title_rules: Record<string, TitleRule>;
  rain_active: boolean;
  timezone: string;
  max_items_per_order: number;
  login_max_attempts: number;
  login_max_attempts_per_ip: number;
  login_lock_minutes: number;
  session_ttl_hours: number;
  password_min_length: number;
  bcrypt_cost: number;
  email_verify_ttl_minutes: number;
  reason_min_length: number;
  receive_code_max_attempts: number;
  receipt_max_bytes: number;
  receipt_url_ttl_seconds: number;
  anomaly_window_minutes: number;
  anomaly_deny_threshold: number;
  job_interval_seconds: number;
}

export type SettingKey = keyof Settings;

export const KNOWN_KEYS: SettingKey[] = [
  "hold_buffer_rate", "price_diff_tolerance_rate", "runner_advance_limit_jpy", "max_orders_per_run",
  "reward_base_jpy", "reward_per_order_jpy", "surcharge_rain_jpy", "surcharge_early_jpy", "early_hours",
  "surcharge_per_km_jpy", "platform_fee_rate", "auto_complete_minutes", "payout_timing", "payout_hour",
  "cancel_deadline_minutes", "order_expire_minutes", "service_radius_km", "title_rules", "rain_active",
  "timezone", "max_items_per_order", "login_max_attempts", "login_max_attempts_per_ip", "login_lock_minutes",
  "session_ttl_hours", "password_min_length", "bcrypt_cost", "email_verify_ttl_minutes", "reason_min_length",
  "receive_code_max_attempts", "receipt_max_bytes", "receipt_url_ttl_seconds", "anomaly_window_minutes",
  "anomaly_deny_threshold", "job_interval_seconds",
];

let defsCache: Map<string, SettingDef> | null = null;

export function loadDefaultDefs(file = path.join(process.cwd(), "config", "settings.default.yaml")): Map<string, SettingDef> {
  if (defsCache) return defsCache;
  const raw = YAML.parse(readFileSync(file, "utf8")) as Record<string, Omit<SettingDef, "key">>;
  const map = new Map<string, SettingDef>();
  for (const [key, d] of Object.entries(raw)) {
    const def: SettingDef = { key, ...d };
    const err = validateValue(def, def.value) ?? (key === "title_rules" ? validateTitleRules(def.value) : null);
    if (err) throw new Error(`settings.default.yaml の ${key} の初期値が不正です: ${err}`);
    map.set(key, def);
  }
  defsCache = map;
  return map;
}

const TIME_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** 値が定義に合っているか。合っていなければ理由（日本語）を返す */
export function validateValue(def: Pick<SettingDef, "type" | "min" | "max" | "options" | "pattern">, value: unknown): string | null {
  switch (def.type) {
    case "int":
    case "decimal": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "数値を入れてください";
      if (def.type === "int" && !Number.isInteger(value)) return "整数を入れてください";
      if (def.min != null && value < def.min) return `${def.min} 以上にしてください`;
      if (def.max != null && value > def.max) return `${def.max} 以下にしてください`;
      return null;
    }
    case "bool":
      return typeof value === "boolean" ? null : "はい/いいえ（true/false）を選んでください";
    case "string":
      if (typeof value !== "string" || value.length === 0) return "文字を入れてください";
      if (value.length > 200) return "200文字以内にしてください";
      if (def.pattern && !new RegExp(def.pattern).test(value)) return "形式が正しくありません";
      return null;
    case "enum":
      return typeof value === "string" && (def.options ?? []).includes(value)
        ? null
        : `次のどれかを選んでください: ${(def.options ?? []).join(", ")}`;
    case "timerange":
      return typeof value === "string" && TIME_RANGE.test(value) ? null : "06:00-08:00 の形で入れてください";
    case "json":
      if (value === null || typeof value !== "object" || Array.isArray(value)) return "JSON のオブジェクトを入れてください";
      if (JSON.stringify(value).length > 10_000) return "大きすぎます";
      return null;
  }
}

/** title_rules の中身のチェック（json 型の中身までは validateValue で見ないため） */
export function validateTitleRules(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return "JSON のオブジェクトを入れてください";
  for (const [name, rule] of Object.entries(v as Record<string, unknown>)) {
    if (!name.trim() || name.length > 30) return "称号の名前は1〜30文字にしてください";
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return `${name} の条件が不正です`;
    for (const [k, n] of Object.entries(rule as Record<string, unknown>)) {
      if (!["monthly_runs", "total_runs", "min_avg_rating"].includes(k)) return `${name}: 使えない条件 ${k}`;
      if (typeof n !== "number" || n < 0) return `${name}: ${k} は0以上の数値にしてください`;
    }
  }
  return null;
}
