import { requestLoginCode } from "../../../../lib/auth";
import { isValidEmail, normalizeEmail } from "../../../../lib/auth-core.mjs";
import { errorResponse } from "../../../../lib/http";

export const dynamic = "force-dynamic";

/** 发验证码：统一成功文案——不回显验证码、不泄露该邮箱是否已注册。 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isValidEmail(email)) return errorResponse(400, "invalid_email", "邮箱格式不正确");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const result = await requestLoginCode(email, ip);
  if (result.ok) return Response.json({ ok: true, message: "验证码已发送，请查收邮箱" });
  if (result.error === "rate_limited") return errorResponse(429, "rate_limited", "发送过于频繁，请稍后再试");
  console.error("[auth/code] 发信失败:", result.reason); // 驱动错误只进服务端日志
  return errorResponse(500, "email_send_failed", "验证码发送失败，请稍后再试");
}
