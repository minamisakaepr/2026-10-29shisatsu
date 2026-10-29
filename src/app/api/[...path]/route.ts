// API の入口はここ1つだけ。すべて門番（dispatch）を通る。
import { boot } from "@/server/boot";
import { dispatch } from "@/server/gate/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  boot();
  return dispatch(req);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
