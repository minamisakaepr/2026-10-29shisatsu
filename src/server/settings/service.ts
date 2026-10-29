// 設定値の読み出し・変更・上書き・差し戻し。変更はすべて履歴（SettingChange）と通行記録に残す。
import { Prisma } from "@prisma/client";
import { prisma, type Db } from "../db";
import { badRequest, notFound } from "../lib/errors";
import { appendAudit } from "../gate/audit";
import { KNOWN_KEYS, loadDefaultDefs, validateTitleRules, validateValue, type Settings, type SettingDef } from "./definitions";

export interface SettingScope {
  shopId?: string | null;
  areaId?: string | null;
}

/** 店舗別 ＞ エリア別 ＞ 全体 の順で、有効な設定値をまとめて返す（＝注文時のスナップショットの中身） */
export async function resolveSettings(scope: SettingScope = {}, db: Db = prisma): Promise<Settings> {
  const rows = await db.setting.findMany();
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  const or: Prisma.SettingOverrideWhereInput[] = [];
  if (scope.areaId) or.push({ scopeType: "area", scopeId: scope.areaId });
  if (scope.shopId) or.push({ scopeType: "shop", scopeId: scope.shopId });
  if (or.length) {
    const ovs = await db.settingOverride.findMany({ where: { OR: or } });
    for (const o of ovs.filter((o) => o.scopeType === "area")) out[o.key] = o.value;
    for (const o of ovs.filter((o) => o.scopeType === "shop")) out[o.key] = o.value;
  }
  for (const k of KNOWN_KEYS) {
    if (!(k in out)) throw new Error(`設定値 ${k} が DB にありません。npm run db:seed を実行してください`);
  }
  return out as unknown as Settings;
}

export async function resolveForShop(shopId: string, db: Db = prisma): Promise<Settings> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { areaId: true } });
  if (!shop) throw notFound("店が見つかりません");
  return resolveSettings({ shopId, areaId: shop.areaId }, db);
}

/** 初回起動時：YAML の初期値を投入（DB にあるキーの値は上書きしない。型・範囲・説明は YAML に合わせる） */
export async function seedDefaults(db: Db = prisma) {
  const defs = loadDefaultDefs();
  for (const def of defs.values()) {
    const meta = {
      type: def.type,
      unit: def.unit,
      description: def.description,
      min: def.min ?? null,
      max: def.max ?? null,
      options: def.options ?? Prisma.DbNull,
      pattern: def.pattern ?? null,
    };
    const existing = await db.setting.findUnique({ where: { key: def.key } });
    if (existing) {
      await db.setting.update({ where: { key: def.key }, data: meta });
    } else {
      await db.setting.create({ data: { key: def.key, value: def.value as Prisma.InputJsonValue, ...meta } });
      await db.settingChange.create({
        data: { key: def.key, scopeType: "global", newValue: def.value as Prisma.InputJsonValue, reason: "初期値の投入" },
      });
    }
  }
}

function defFromRow(row: { type: string; min: number | null; max: number | null; options: unknown; pattern: string | null }) {
  return {
    type: row.type as SettingDef["type"],
    min: row.min ?? undefined,
    max: row.max ?? undefined,
    options: (row.options as string[] | null) ?? undefined,
    pattern: row.pattern ?? undefined,
  };
}

async function checkValue(db: Db, key: string, value: unknown) {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) throw notFound(`設定 ${key} はありません`);
  const err = validateValue(defFromRow(row), value) ?? (key === "title_rules" ? validateTitleRules(value) : null);
  if (err) throw badRequest(`${key}: ${err}`, "invalid_setting");
  return row;
}

export interface Actor {
  userId: string | null;
  role: string;
  ip?: string | null;
}

export async function updateGlobal(key: string, value: unknown, reason: string, actor: Actor, revertOfId?: string) {
  return prisma.$transaction(async (tx) => {
    const row = await checkValue(tx, key, value);
    await tx.setting.update({ where: { key }, data: { value: value as Prisma.InputJsonValue, updatedById: actor.userId } });
    const change = await tx.settingChange.create({
      data: {
        key, scopeType: "global", oldValue: row.value as Prisma.InputJsonValue, newValue: value as Prisma.InputJsonValue,
        changedById: actor.userId, reason, revertOfId,
      },
    });
    await appendAudit(
      { userId: actor.userId, role: actor.role, entrance: "settings.change", operation: "update", target: `setting:${key}`, result: "info", ip: actor.ip, detail: { old: row.value, new: value, reason, scope: "global", revertOfId } },
      tx,
    );
    return change;
  });
}

export async function setOverride(key: string, scopeType: "area" | "shop", scopeId: string, value: unknown, reason: string, actor: Actor, revertOfId?: string) {
  return prisma.$transaction(async (tx) => {
    await checkValue(tx, key, value);
    const exists = scopeType === "area"
      ? await tx.area.findUnique({ where: { id: scopeId } })
      : await tx.shop.findUnique({ where: { id: scopeId } });
    if (!exists) throw notFound(scopeType === "area" ? "エリアが見つかりません" : "店が見つかりません");
    const where = { key_scopeType_scopeId: { key, scopeType, scopeId } };
    const old = await tx.settingOverride.findUnique({ where });
    await tx.settingOverride.upsert({
      where,
      create: { key, scopeType, scopeId, value: value as Prisma.InputJsonValue, updatedById: actor.userId },
      update: { value: value as Prisma.InputJsonValue, updatedById: actor.userId },
    });
    const change = await tx.settingChange.create({
      data: {
        key, scopeType, scopeId, oldValue: (old?.value as Prisma.InputJsonValue) ?? Prisma.DbNull,
        newValue: value as Prisma.InputJsonValue, changedById: actor.userId, reason, revertOfId,
      },
    });
    await appendAudit(
      { userId: actor.userId, role: actor.role, entrance: "settings.change", operation: "update", target: `setting:${key}@${scopeType}:${scopeId}`, result: "info", ip: actor.ip, detail: { old: old?.value ?? null, new: value, reason, revertOfId } },
      tx,
    );
    return change;
  });
}

export async function deleteOverride(key: string, overrideId: string, reason: string, actor: Actor, revertOfId?: string) {
  return prisma.$transaction(async (tx) => {
    const ov = await tx.settingOverride.findUnique({ where: { id: overrideId } });
    if (!ov || ov.key !== key) throw notFound("上書きが見つかりません");
    await tx.settingOverride.delete({ where: { id: overrideId } });
    const change = await tx.settingChange.create({
      data: {
        key, scopeType: ov.scopeType, scopeId: ov.scopeId, oldValue: ov.value as Prisma.InputJsonValue,
        newValue: Prisma.DbNull, changedById: actor.userId, reason, revertOfId,
      },
    });
    await appendAudit(
      { userId: actor.userId, role: actor.role, entrance: "settings.change", operation: "delete", target: `setting:${key}@${ov.scopeType}:${ov.scopeId}`, result: "info", ip: actor.ip, detail: { old: ov.value, reason, revertOfId } },
      tx,
    );
    return change;
  });
}

/** 履歴の1件を指定して、その変更の「前の値」に戻す（戻したこと自体も新しい履歴になる） */
export async function revertChange(changeId: string, reason: string, actor: Actor) {
  const ch = await prisma.settingChange.findUnique({ where: { id: changeId } });
  if (!ch) throw notFound("履歴が見つかりません");
  if (ch.scopeType === "global") {
    if (ch.oldValue === null) throw badRequest("これは初期値の投入なので、戻す前の値がありません");
    return updateGlobal(ch.key, ch.oldValue, reason, actor, ch.id);
  }
  const scopeType = ch.scopeType as "area" | "shop";
  const scopeId = ch.scopeId!;
  if (ch.oldValue === null) {
    const ov = await prisma.settingOverride.findUnique({ where: { key_scopeType_scopeId: { key: ch.key, scopeType, scopeId } } });
    if (!ov) throw badRequest("すでに上書きはありません");
    return deleteOverride(ch.key, ov.id, reason, actor, ch.id);
  }
  return setOverride(ch.key, scopeType, scopeId, ch.oldValue, reason, actor, ch.id);
}
