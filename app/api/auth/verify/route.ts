import { cookies } from "next/headers";
import { verifyLoginCode } from "../../../../lib/auth";
import { SESSION_COOKIE, SESSION_TTL_DAYS, isValidEmail, normalizeEmail } from "../../../../lib/auth-core.mjs";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 校验验证码 → upsert 用户（新邮箱即注册）+ 建 Web 会话。失败统一模糊文案，不区分码错/过期/耗尽。 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) return errorResponse(400, "invalid_code", "验证码错误或已过期");
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
