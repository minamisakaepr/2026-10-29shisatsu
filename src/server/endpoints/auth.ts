import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db";
import { loadEnv } from "../env";
import { randomToken, sha256 } from "../lib/crypto";
import { AppError, badRequest } from "../lib/errors";
import { clearSessionCookie, createSession, sessionCookie, readCookie, SESSION_COOKIE, type Principal } from "../gate/session";
import { endpoint, WithHeaders } from "../gate/types";
import { resolveSettings } from "../settings/service";
import type { LedgerRole } from "../gate/ledger";

// ユーザーが存在しないときも同じ時間がかかるようにするための、ダミーのハッシュ
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

const email = z.string().trim().toLowerCase().email().max(200);

export const authEndpoints = [
  endpoint({
    id: "api.auth.login",
    input: z.object({ email, password: z.string().min(1).max(200) }),
    async handler(ctx) {
      const s = await resolveSettings();
      const since = new Date(Date.now() - s.login_lock_minutes * 60_000);
      const [byEmail, byIp] = await Promise.all([
        prisma.loginAttempt.count({ where: { email: ctx.input.email, success: false, at: { gte: since } } }),
        ctx.ip ? prisma.loginAttempt.count({ where: { ip: ctx.ip, success: false, at: { gte: since } } }) : 0,
      ]);
      if (byEmail >= s.login_max_attempts || byIp >= s.login_max_attempts_per_ip) {
        throw new AppError(429, "locked", `ログインの失敗が続いたため、${s.login_lock_minutes}分間ロックしています`);
      }
      const user = await prisma.user.findUnique({ where: { email: ctx.input.email }, include: { roles: true } });
      const ok = await bcrypt.compare(ctx.input.password, user?.passwordHash ?? DUMMY_HASH);
      const usable = ok && user && !user.disabledAt && user.emailVerifiedAt && user.roles.length > 0;
      await prisma.loginAttempt.create({ data: { email: ctx.input.email, ip: ctx.ip, success: Boolean(usable) } });
      if (!usable) {
        if (ok && user && !user.emailVerifiedAt) throw new AppError(401, "unverified", "メールアドレスの確認がまだです。届いたリンクを開いてください");
        throw new AppError(401, "bad_credentials", "メールアドレスかパスワードが違います");
      }
      // 古いログイン状態は消す（セッション固定攻撃の対策）
      const old = readCookie(ctx.req.headers.get("cookie"), SESSION_COOKIE);
      if (old) await prisma.session.deleteMany({ where: { tokenHash: sha256(old) } });
      const { token, expiresAt } = await createSession(user.id, s.session_ttl_hours, ctx.ip);
      const roles = user.roles.map((r) => r.role as LedgerRole);
      const principal: Principal = { userId: user.id, sessionId: null, roles };
      const secure = loadEnv().appUrl.startsWith("https://");
      return new WithHeaders({ ok: true, roles }, { "set-cookie": sessionCookie(token, expiresAt, secure) }, 200, principal);
    },
  }),

  endpoint({
    id: "api.auth.logout",
    async handler(ctx) {
      if (ctx.principal.sessionId) await prisma.session.deleteMany({ where: { id: ctx.principal.sessionId } });
      const secure = loadEnv().appUrl.startsWith("https://");
      return new WithHeaders({ ok: true }, { "set-cookie": clearSessionCookie(secure) });
    },
  }),

  endpoint({
    id: "api.auth.signup",
    input: z.object({
      email,
      password: z.string().max(200),
      displayName: z.string().trim().min(1).max(30),
      asRunner: z.boolean().default(false),
    }),
    async handler(ctx) {
      const s = await resolveSettings();
      if (ctx.input.password.length < s.password_min_length) throw badRequest(`パスワードは${s.password_min_length}文字以上にしてください`);
      const exists = await prisma.user.findUnique({ where: { email: ctx.input.email } });
      // すでに登録済みでも同じ返事にする（登録済みのメールアドレスを調べられないように）
      if (exists) return { ok: true };
      const user = await prisma.user.create({
        data: {
          email: ctx.input.email,
          passwordHash: await bcrypt.hash(ctx.input.password, s.bcrypt_cost),
          displayName: ctx.input.displayName,
          roles: { create: [{ role: "customer" }, ...(ctx.input.asRunner ? [{ role: "runner" as const }] : [])] },
        },
      });
      const token = randomToken();
      await prisma.emailVerification.create({
        data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + s.email_verify_ttl_minutes * 60_000) },
      });
      // 開発用：メール送信の代わりに、サーバーのログに確認リンクを出す（本番前にメール送信に差し替える）
      console.log(`[開発用メール] ${ctx.input.email} の確認リンク: ${loadEnv().appUrl}/verify?token=${token}`);
      return { ok: true };
    },
  }),

  endpoint({
    id: "api.auth.verify",
    input: z.object({ token: z.string().min(10).max(200) }),
    async handler(ctx) {
      const v = await prisma.emailVerification.findUnique({ where: { tokenHash: sha256(ctx.input.token) } });
      if (!v || v.usedAt || v.expiresAt < new Date()) throw badRequest("確認リンクが無効か、期限切れです");
      await prisma.$transaction([
        prisma.emailVerification.update({ where: { id: v.id }, data: { usedAt: new Date() } }),
        prisma.user.update({ where: { id: v.userId }, data: { emailVerifiedAt: new Date() } }),
      ]);
      return { ok: true };
    },
  }),

  endpoint({
    id: "api.me.show",
    async handler(ctx) {
      if (!ctx.principal.userId) return { loggedIn: false };
      const u = await prisma.user.findUniqueOrThrow({ where: { id: ctx.principal.userId } });
      return { loggedIn: true, id: u.id, displayName: u.displayName, roles: ctx.principal.roles, payoutsEnabled: u.payoutsEnabled };
    },
  }),
];
