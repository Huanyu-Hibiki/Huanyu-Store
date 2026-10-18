import { cookies } from "next/headers";
import { isVerifyRateLimited, verifyLoginCode } from "../../../../lib/auth";
import { SESSION_COOKIE, SESSION_TTL_DAYS, isValidEmail, normalizeEmail, normalizeIp } from "../../../../lib/auth-core.mjs";
import { errorResponse, sameOrigin } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 校验验证码 → upsert 用户（新邮箱即注册）+ 建 Web 会话。失败统一模糊文案，不区分码错/过期/耗尽。 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return errorResponse(403, "origin_forbidden", "请求来源校验失败");
  const body = (await request.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) return errorResponse(400, "invalid_code", "验证码错误或已过期");
  // 信任边界：Vercel 平台覆写 x-forwarded-for（不可伪造）；自托管部署须由反代保证同语义
  const ip = normalizeIp(request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown");
  if (await isVerifyRateLimited(ip)) return errorResponse(429, "rate_limited", "尝试过于频繁，请稍后再试");
  const result = await verifyLoginCode(email, code);
  if (!result.ok) return errorResponse(400, "invalid_code", "验证码错误或已过期");
  const store = await cookies();
  store.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 3600,
  });
  return Response.json({ email: result.email });
}
