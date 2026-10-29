// 門番（画面用）。middleware.ts から呼ばれる。画面そのものにはデータを入れず、データは API 側の門番で守る。
import { appendAudit } from "./audit";
import { findGrant, getLedger, matchEntrance } from "./ledger";
import { clientIp, principalFromToken, readCookie, SESSION_COOKIE } from "./session";

export type PageDecision =
  | { kind: "allow" }
  | { kind: "login"; next: string }
  | { kind: "forbidden" }
  | { kind: "not_found" };

export async function gatePage(req: Request): Promise<PageDecision> {
  const url = new URL(req.url);
  const principal = await principalFromToken(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
  const match = matchEntrance(getLedger(), ["page"], null, url.pathname);
  const grant = match ? findGrant(match.entrance, principal.roles) : null;
  const decision: PageDecision = !match
    ? { kind: "not_found" }
    : grant
      ? { kind: "allow" }
      : principal.userId
        ? { kind: "forbidden" }
        : { kind: "login", next: url.pathname };
  await appendAudit({
    userId: principal.userId,
    role: grant?.role ?? principal.roles.join(","),
    entrance: match?.entrance.id ?? "unknown",
    operation: "read",
    target: url.pathname,
    result: decision.kind === "allow" ? "allow" : "deny",
    ip: clientIp(req),
    detail: { kind: "page", decision: decision.kind },
  });
  return decision;
}
