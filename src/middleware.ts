// 画面へのアクセスを門番に通す。API（/api/）は app/api/[...path] の門番が見る。
import { NextResponse, type NextRequest } from "next/server";
import { boot } from "@/server/boot";
import { gatePage } from "@/server/gate/page";
import { CSRF_COOKIE, csrfCookie } from "@/server/gate/session";
import { randomToken } from "@/server/lib/crypto";
import { loadEnv } from "@/server/env";

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};

function withCsrf(req: NextRequest, res: NextResponse) {
  if (!req.cookies.get(CSRF_COOKIE)) {
    res.headers.append("set-cookie", csrfCookie(randomToken(), loadEnv().appUrl.startsWith("https://")));
  }
  return res;
}

export async function middleware(req: NextRequest) {
  boot();
  if (req.nextUrl.pathname.startsWith("/api/")) return withCsrf(req, NextResponse.next());
  const d = await gatePage(req);
  if (d.kind === "allow") return withCsrf(req, NextResponse.next());
  if (d.kind === "login") {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", d.next);
    return withCsrf(req, NextResponse.redirect(url));
  }
  if (d.kind === "forbidden") return withCsrf(req, NextResponse.redirect(new URL("/forbidden", req.url)));
  return new NextResponse("見つかりません", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
