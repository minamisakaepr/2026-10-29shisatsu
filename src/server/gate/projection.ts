// 見せてよい項目だけに絞り込む（出口側の制限）。
// fields の書き方は security/access_ledger.yaml の先頭を参照。
import type { Field } from "./ledger";

interface Node {
  leaf: boolean;
  when?: string[]; // この項目を返す条件（status がこのどれか）
  children: Map<string, Node>;
}

const newNode = (): Node => ({ leaf: false, children: new Map() });

function build(fields: Field[]): Node | "all" {
  const root = newNode();
  for (const f of fields) {
    const p = typeof f === "string" ? f : f.path;
    if (p === "*") return "all";
    let node = root;
    const parts = p.split(".");
    parts.forEach((part, i) => {
      if (!node.children.has(part)) node.children.set(part, newNode());
      node = node.children.get(part)!;
      if (i === parts.length - 1) {
        node.leaf = true;
        if (typeof f !== "string") node.when = f.when.status;
      }
    });
  }
  return root;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

/** ctx = その項目を含む一番内側の配列要素（なければ1件分のデータ） */
function walk(value: unknown, node: Node, ctx: Record<string, unknown> | null): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of node.children) {
    const isArray = key.endsWith("[]");
    const name = isArray ? key.slice(0, -2) : key;
    if (!(name in value)) continue;
    const v = value[name];
    if (child.when && !child.when.includes(String(ctx?.status))) continue;
    if (isArray) {
      if (!Array.isArray(v)) continue;
      out[name] = child.leaf && child.children.size === 0
        ? v.filter((x) => !isPlainObject(x)) // 配列そのもの（中身は文字や数値だけ許可）
        : v.map((x) => (isPlainObject(x) ? walk(x, child, x) : null));
    } else if (child.children.size > 0) {
      out[name] = v === null ? null : walk(v, child, ctx);
    } else {
      out[name] = v;
    }
  }
  return out;
}

export function project(data: unknown, fields: Field[] | undefined): unknown {
  if (!fields || fields.length === 0) return null;
  const tree = build(fields);
  if (tree === "all") return data;
  if (Array.isArray(data)) return data.map((x) => (isPlainObject(x) ? walk(x, tree, x) : null));
  return isPlainObject(data) ? walk(data, tree, data) : null;
}
