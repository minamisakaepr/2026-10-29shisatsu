import type { z } from "zod";
import type { Entrance, Grant, LedgerRole } from "./ledger";
import type { Principal } from "./session";

export interface Ctx<I = unknown> {
  req: Request;
  principal: Principal;
  /** ログイン中のユーザー ID（anonymous の出入り口では空文字） */
  userId: string;
  /** 台帳の、どのロールの行で許可されたか */
  role: LedgerRole;
  entrance: Entrance;
  grant: Grant;
  params: Record<string, string>;
  query: URLSearchParams;
  input: I;
  /** データ範囲（scope）から作った検索条件。一覧を出す処理は必ずこれを where に入れる */
  where: Record<string, unknown>;
  form: FormData | null;
  rawBody: string | null;
  ip: string | null;
  /** require_reason の出入り口で入力された理由 */
  reason: string | null;
}

/** JSON 以外（ファイル・CSV・Cookie 付きなど）を返すときに使う */
export class RawResponse {
  constructor(public response: Response) {}
}

/** JSON で返すが、Cookie などのヘッダーも付けたいとき */
export class WithHeaders {
  constructor(
    public data: unknown,
    public headers: Record<string, string | string[]>,
    public status = 200,
    /** ログイン・ログアウトで「だれか」が変わったとき、通行記録に使う新しい値 */
    public principal?: Principal,
  ) {}
}

export interface EndpointDef<S extends z.ZodType = z.ZodType> {
  /** 台帳（access_ledger.yaml）の id と同じ */
  id: string;
  body?: "json" | "multipart" | "raw" | "none";
  input?: S;
  handler: (ctx: Ctx<z.infer<S>>) => Promise<unknown>;
}

export function endpoint<S extends z.ZodType>(def: EndpointDef<S>): EndpointDef<S> {
  return def;
}
