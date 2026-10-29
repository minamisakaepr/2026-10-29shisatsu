// レシート画像の非公開保存と、期限付き URL
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../env";
import { hmac, randomToken, safeEqual, sha256 } from "./crypto";
import { badRequest } from "./errors";

const KINDS: { mime: string; ext: string; magic: number[] }[] = [
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"…"WEBP"
];

/** ファイルの中身（先頭バイト）から画像の種類を判定する。拡張子や申告された種類は信用しない */
export function detectImage(buf: Buffer) {
  for (const k of KINDS) {
    if (k.magic.every((b, i) => buf[i] === b)) {
      if (k.ext === "webp" && buf.subarray(8, 12).toString("ascii") !== "WEBP") continue;
      return k;
    }
  }
  return null;
}

function receiptsDir() {
  return path.resolve(loadEnv().storageDir, "receipts");
}

export async function saveReceipt(buf: Buffer, maxBytes: number) {
  if (buf.length === 0) throw badRequest("レシート画像がありません");
  if (buf.length > maxBytes) throw badRequest(`レシート画像は ${Math.floor(maxBytes / 1_000_000)}MB 以下にしてください`);
  const kind = detectImage(buf);
  if (!kind) throw badRequest("レシート画像は JPEG / PNG / WebP にしてください");
  const key = `${randomToken(24)}.${kind.ext}`;
  await mkdir(receiptsDir(), { recursive: true });
  await writeFile(path.join(receiptsDir(), key), buf, { flag: "wx" });
  return { storageKey: key, mime: kind.mime, size: buf.length, sha256: sha256(buf) };
}

export async function readReceipt(storageKey: string) {
  if (!/^[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(storageKey)) throw badRequest("不正なファイル名です");
  return readFile(path.join(receiptsDir(), storageKey));
}

/** 期限付き URL（ログインと範囲チェックに加えて、署名と期限も確かめる） */
export function signedReceiptUrl(receiptId: string, ttlSeconds: number, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = hmac(loadEnv().appSecret, `receipt:${receiptId}:${exp}`);
  return `/api/files/receipts/${receiptId}?exp=${exp}&sig=${sig}`;
}

export function verifyReceiptSignature(receiptId: string, exp: string | null, sig: string | null, now = Date.now()) {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  return safeEqual(sig, hmac(loadEnv().appSecret, `receipt:${receiptId}:${exp}`));
}
